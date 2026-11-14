/**
 * Originals anchored on an EVM chain: assembling the log from the Original's
 * token, and following a move across chains (originals-spec PR 59, proposed:
 * P9.19-P9.29, P14.18-P14.22, P7.14). EXPERIMENTAL and PROVISIONAL throughout:
 * P14.21 pins no anchor contract, so this runs only under a pin an experiment
 * supplies (`EvmAnchorPin`); with none, an Original with an `anchor` member is
 * unsupported, never invalid.
 *
 * The caller supplies, per token, what each JSON-RPC provider read at the
 * finalized block (`EvmTokenEvidence`). Those are adapter assertions (P9.21);
 * nothing here talks to a chain. The rules of P9.12-P9.17 then apply with the
 * readings of P9.20, through the same assembly as Bitcoin
 * (`assembleAnchored`): a record is an inscription at height = its index,
 * so publications are accepted in index order, more than one per block; its
 * inscription time is the greatest timestamp among it and the token's
 * earlier records.
 *
 * - P9.21: a provider counts only if it reports the listed chain ID and the
 *   listed hash of block 0; the code at the pinned address must have the
 *   pinned code hash, or the Original is unsupported (never invalid, never
 *   not anchored).
 * - P9.22 (PR 59 1b5c484; owner decision, 13 November 2026): a provider is
 *   usable only if it passes P9.21's checks and serves the contract's state
 *   at the finalized block. One that is not is dropped, its answers are not
 *   evidence, and the reads of those that remain stand: one usable provider
 *   is enough, and its read is reported uncorroborated. Evidence is missing
 *   only when none remains. The reads are at the lower of the usable
 *   providers' finalized blocks; usable providers that disagree on that
 *   block's hash or on the state at it leave the evidence missing, and
 *   neither is dropped to settle it. Records above it are observed, never
 *   accepted. A retained finalized block that the chain has replaced is a
 *   finality failure with `authoritative-source-changed`.
 * - P9.23: the owner is `ownerOf` at that block, only once anchored.
 * - P9.25, P14.20: a record over the limits is rejected from its fields,
 *   without its bytes, and never makes evidence missing; any other record
 *   whose bytes were not read does. A read may resume after a retained
 *   checkpoint's record index, with a supplied log whose entry N is the
 *   checkpoint's head (`resumableCheckpoint`).
 * - P9.28, P9.29: a move departs with the move entry accepted on the token
 *   left, and arrives with the first publication on the destination carrying
 *   exactly the entries accepted through the departure. Bitcoin as the
 *   destination uses `assembleFromBitcoin` with the same arrival rule.
 */
import { OriginalsError } from "../errors.js";
import type { LogEntry, LogVerification } from "../log/index.js";
import type { AuthorHistory } from "./author.js";
import {
  ORIGINALS_INSCRIPTION_MAX_BYTES,
  assembleAnchored,
  assembleFromBitcoin,
  departsFrom,
  readInscribedEntries,
  type AnchorKind,
  type AnchorRead,
  type AnchoringReport,
  type Assembly,
  type IgnoredReason,
  type Placed,
  type RetainedAnchor,
} from "./bitcoin.js";
import type { SatEvidence, SatInscription } from "./btco.js";
import {
  anchorAddress,
  caip19Of,
  checkAnchor,
  checkpointAlias,
  isEvmCheckpoint,
  versionNumber,
  parseEvmAlias,
  tokenIdOf,
  classAt,
  currentClass,
  describeClass,
  evmSupport,
  layerOfClass,
  type EvmAnchor,
  type EvmAnchorPin,
  type EvmCheckpoint,
  type EvmCheckpointPlacement,
  type EvmProviderRead,
  type EvmRecord,
  type EvmTokenEvidence,
  type ListedChain,
  type RetainedEvmBlock,
  type TrustClass,
} from "./evm.js";
import { derivedTokenAlias, type AssetState } from "./state.js";

/** What a verifier is given to verify an Original anchored on an EVM chain (P9.21, P9.22). */
export interface EvmEvidence {
  /** The P14.21 pin; the spec pins none (`SPEC_EVM_PIN`), so without one the Original is unsupported. */
  pin: EvmAnchorPin | null;
  /** Every provider's read of each token the caller knows of: the Original's, and those a move names. */
  tokens: EvmTokenEvidence[];
  /** The finalized blocks this verifier relied on before, per chain (P9.22). */
  retained?: RetainedEvmBlock[];
  /**
   * P9.25 (PR 59 1b5c484, MAY): checkpoints this verifier retained
   * (`OriginalsReport.retain.evmCheckpoints`). A read whose `from` is a
   * checkpoint's `record` + 1 resumes from it, when the supplied log's entry
   * N is the checkpoint's head; a value that is not a checkpoint
   * (`isEvmCheckpoint`) is ignored, and one resting on a block the chain
   * replaced is discarded (P9.22).
   */
  checkpoints?: unknown[];
  /**
   * P3.9: the did:evm alias being resolved with no copy of the log. The
   * candidate Original is then taken only from an anchoring or arrival
   * publication on that token. Without it and without a copy, from such a
   * publication on any supplied token.
   */
  resolving?: string;
  /**
   * P9.18 (PR 59 1b5c484; owner decision, 13 November 2026): the supplied log
   * is the writer's own committed log, not yet on the chain, which it checks
   * before publishing an entry. With no token read at all (`tokens` empty),
   * it is verified whole, from genesis, as a local copy: unverified on the
   * chain (`evm-evidence-missing`), with claimed ordering, never current, with
   * no owner, and marked `localCopy` with the reason `local-copy`. Such a
   * result is valid only for the writer's own check before it publishes and
   * MUST NOT appear in a report given to anyone else. Any token read decides
   * as without it: a copy is never preferred to the anchor (P7.14). A carried
   * log or a package is never a local copy.
   */
  localCopy?: boolean;
}

/** A publication accepted on a token (P9.20): its record index and the timestamp the record holds. */
export interface EvmPlaced {
  token: string;
  index: number;
  versionId: string;
  /** The block timestamp the record holds, seconds (P14.20). */
  timestamp: number;
  /** The greatest timestamp among the record and the token's earlier records, ms (P9.20). */
  inscriptionTime: number;
}

/**
 * Why a provider was dropped (P9.21, P9.22): it serves another chain, or it
 * cannot serve the contract's state at the finalized block (`state-unavailable`,
 * including records it could not read there). Its answers are not evidence.
 */
export type ProviderExclusion = "wrong-chain-id" | "wrong-genesis-hash" | "other-chain" | "state-unavailable";

/**
 * One chain the Original was anchored on (P9.27, P9.29): its trust class as
 * this verifier's revision of P14.22 lists it, what was accepted there, the
 * finalized block and the providers used.
 */
export interface EvmStretch {
  chain: string;
  name: string;
  /** The class of the revision this verifier implements (P9.27). */
  class: TrustClass;
  /**
   * How the ordering of this stretch's `entries` is described (P9.27, P9.29):
   * as its class requires once the token is read; `claimed` when the token
   * could not be read, as for a chain the Original left that is unreadable.
   */
  ordering: ReturnType<typeof describeClass> | "claimed";
  /** For a stretch the Original left, the class at the departure record's timestamp, by which the move was judged (P9.28). */
  classAtDeparture?: TrustClass;
  layer: "attested" | "proven";
  /** How a report describes ordering, ownership, uniqueness and the settlement of a fork on this chain (P9.27). */
  describes: ReturnType<typeof describeClass>;
  token: string;
  /** For wallets; never an alias (P14.18). */
  caip19: string;
  /**
   * anchored: an anchor (or arrival) was accepted. departed is set separately.
   * not-anchored: the token was read and holds no valid anchoring publication,
   * or, for a destination, no arrival. unverified: the token's evidence is
   * missing (P9.22, P9.25).
   */
  status: "anchored" | "not-anchored" | "unverified";
  /** Reached by a move (P9.29): its first accepted publication is the arrival. */
  arrival: boolean;
  anchor: EvmPlaced | null;
  /** Other valid anchoring publications on the token; never current (P9.16, P9.24). */
  conflicting: EvmPlaced[];
  /** Publications accepted after the anchor or arrival, in index order. */
  accepted: EvmPlaced[];
  /**
   * The entries accepted while the Original was here (P9.29): the anchoring
   * entry (not an arrival's carried entries) and those accepted after it.
   */
  entries: string[];
  /** Entries carried before the anchoring entry, with claimed ordering (P9.15, P9.16), or an arrival's carried entries, which keep their earlier stretch's ordering (P9.29). */
  carried: string[];
  /** The move entry accepted here, when the Original left (P9.29). */
  departure: (EvmPlaced & { destination: string }) | null;
  ignored: Array<{ index: number; versionId?: string; reason: IgnoredReason | "observed-not-finalized"; code?: string; waitingOn?: number }>;
  unverifiable: Array<{ index: number; versionId?: string; signer: string; signerVersionId: string }>;
  /** Records seen above the finalized block: pending, never accepted (P9.22, P9.27). */
  observed: Array<{ index: number; timestamp: number }>;
  /** The finalized block relied on (P9.22): every report states it. */
  block: { number: number; hash: string } | null;
  /** The usable providers the read came from (P9.22, P9.27). */
  providers: string[];
  /** P9.22 (1b5c484): only one usable provider answered the read. */
  uncorroborated: boolean;
  /** Providers dropped, whose answers are not evidence (P9.21, P9.22). */
  excludedProviders: Array<{ provider: string; reason: ProviderExclusion }>;
  /** `ownerOf` at the block, when the token exists. Ownership is reported in `EvmAnchoringReport.owner`. */
  holder: string | null;
  /** P9.22: failed when a retained finalized block of this chain was replaced. */
  finality: "held" | "failed" | "unchecked";
  /**
   * P9.24 (MAY; PR 59 a3ffdc1): the anchor's uniqueness in the terms of the
   * chain's class (P9.27): established on a `consensus` or `exit-protected`
   * chain, attested by the operator on an `operator` chain, attested by the
   * validators on a `consortium` chain. Each holds only under the chain's
   * finality and the providers used (`block`, `providers`). Not established
   * after a finality failure.
   */
  uniqueness: EvmUniqueness;
  /** P9.25: the retained checkpoint this read resumed from, reading only the records after its record index. */
  resumedFrom?: { head: string; record: number; block: { number: number; hash: string } };
  /** Why the evidence is missing (P9.22, P9.25). */
  missing?: { code: string; message: string };
  /** P9.16: a different anchor than the retained one. */
  change: AnchoringReport["change"];
  headChange: AnchoringReport["headChange"];
}

export interface EvmOwnership {
  /** On a `consensus` or `exit-protected` chain proven on that chain; otherwise attested (P9.27). Never Bitcoin ownership. */
  describes: ReturnType<typeof describeClass>;
  chain: string;
  class: TrustClass;
  token: string;
  /** What `ownerOf` returned at the block: an account or a contract (P9.23). */
  address: string;
  block: { number: number; hash: string };
  providers: string[];
  /** P9.22 (1b5c484): only one usable provider answered the read. */
  uncorroborated: boolean;
}

export interface EvmAnchoringReport {
  /**
   * anchored: on the last chain in `stretches`. moved-to-bitcoin: arrived on
   * Bitcoin, reported in `OriginalsReport.anchoring`. departed-not-arrived:
   * the move entry is accepted, no arrival yet (P9.29). not-anchored: no
   * valid anchoring publication on the token (P9.23). unverified: evidence
   * missing (P9.22, P9.25, P7.14). unsupported: no pin, an unlisted chain, or
   * other code at the pinned address (P9.19, P9.21, P14.21).
   */
  status: "anchored" | "moved-to-bitcoin" | "departed-not-arrived" | "not-anchored" | "unverified" | "unsupported";
  /** none: never moved. confirmed: every departure was read final. unconfirmed: a chain left could not be read, or replaced the departure's block (P9.29). */
  move: "none" | "confirmed" | "unconfirmed";
  stretches: EvmStretch[];
  /** Only for an anchored Original whose every move is confirmed (P9.23, P9.29). */
  owner: EvmOwnership | null;
  /**
   * For departed-not-arrived, or a final departure whose destination could not
   * be read: where the move entry goes (P9.29).
   */
  destination: string | null;
  /**
   * P9.29, for the last move: `arrived` once the arrival is accepted;
   * `not-arrived` when the destination was read and holds none; `unknown`
   * when the departure is final but the destination could not be read, which
   * is missing evidence and claims neither an arrival nor its lack. Null with
   * no move.
   */
  arrival: "arrived" | "not-arrived" | "unknown" | null;
  /**
   * P9.29 (PR 59 a3ffdc1): the entries before the first anchoring entry,
   * described as carried with claimed ordering after any number of moves.
   * Their proofs and hash links are checked; carrying them does not order
   * them.
   */
  carried: { entries: string[]; ordering: "claimed" };
  unsupported: { code: string; message: string; chain: string } | null;
  /** VH-Log's warning when a finalized block was replaced (P9.22, [S20]). */
  warnings: Array<"authoritative-source-changed">;
  /**
   * P7.14, P9.29: when evidence is missing for the chain the Original is
   * anchored on now (or its destination), the entries of the supplied log
   * from the first anchoring entry on, through any move entry: not checked
   * against the Original's current anchor, though a chain it left accepted
   * them. The log reported then ends before them.
   */
  notCheckedAgainstAnchor: string[];
  /**
   * P9.18 (1b5c484): the result is the writer's own local copy (`localCopy`),
   * valid only for its own check before publishing, never for a report given
   * to anyone else.
   */
  localCopy: boolean;
}

export interface EvmAssembly {
  /** The log to verify: what the anchors accepted, or at most the entries before the first anchoring entry when evidence is missing (P7.14). */
  entries: unknown[];
  report: EvmAnchoringReport;
  /** The Bitcoin assembly, when the Original moved to Bitcoin (P9.28). */
  bitcoin: Assembly | null;
  /** Bodies of accepted publications, by digest, with the chain each was read from (P9.25). */
  bytes: Map<string, { bytes: Uint8Array; chain: string }>;
  rejectedByAuthorState: Set<string>;
  /** The anchor to retain, on the last token read (P9.16). */
  retainedAnchor?: RetainedAnchor;
  /** The finalized blocks relied on, per chain, to retain (P9.22). */
  retainedBlocks: RetainedEvmBlock[];
  /** P9.25: a verified checkpoint per token read, to retain. */
  checkpoints: EvmCheckpoint[];
  /**
   * P9.22: per chain, the lowest retained block number evidence showed
   * replaced. Every retained result and checkpoint resting on it or a later
   * block is discarded.
   */
  replaced: Array<{ chain: string; from: number }>;
}

/** P9.24 (PR 59 a3ffdc1): uniqueness in the terms of the chain's class; not established after a finality failure (1b5c484). */
export type EvmUniqueness =
  | {
    status: "established" | "attested-by-operator" | "attested-by-validators";
    chain: string;
    class: TrustClass;
    /** It holds only under the chain's finality and these providers' reads at this block. */
    block: { number: number; hash: string };
    providers: string[];
    /** P9.22 (1b5c484): only one usable provider answered the read. */
    uncorroborated: boolean;
  }
  | { status: "not-established" };

/** P9.24: how a chain's class lets a report state an anchor's uniqueness. */
export function uniquenessStatus(cls: TrustClass): "established" | "attested-by-operator" | "attested-by-validators" {
  const d = describeClass(cls);
  return d === "proven" ? "established" : d;
}

type Verify = (entries: unknown[], options?: { unauthorized?: ReadonlySet<number> }) => Promise<LogVerification>;

const MEDIA_TYPE_MAX_BYTES = 255;
const utf8Length = (s: string) => new TextEncoder().encode(s).length;
const lower = (s: string | null) => (s === null ? null : s.toLowerCase());
const sameBytes = (a?: Uint8Array, b?: Uint8Array) => (a === undefined ? b === undefined : b !== undefined && a.length === b.length && a.every((x, k) => x === b[k]));

function assetOf(entry: unknown): AssetState | undefined {
  return (entry as { state?: { asset?: AssetState } } | null)?.state?.asset;
}

/** The did:evm token alias an entry lists. */
export function tokenNamedBy(entry: unknown): string | undefined {
  const aliases = assetOf(entry)?.aliases;
  return Array.isArray(aliases) ? aliases.find((a) => typeof a === "string" && a.startsWith("did:evm:")) : undefined;
}

/** The `anchor` member of an entry, when it has a well-formed one. */
export function anchorOf(entry: unknown): EvmAnchor | undefined {
  const a = assetOf(entry)?.anchor;
  if (a === undefined) return undefined;
  try {
    return checkAnchor(a);
  } catch (error) {
    if (error instanceof OriginalsError) return undefined;
    throw error;
  }
}

/** P9.20: the EVM reading of an anchor layer's naming and size rules. Records over the limits never reach the assembly. */
const EVM_KIND: AnchorKind = Object.freeze({
  anchoringIndex: (entries: unknown[]) => entries.findIndex((e) => tokenNamedBy(e) !== undefined),
  namedBy: (entry: unknown) => tokenNamedBy(entry),
  tooLarge: () => false,
  departs: (entry: LogEntry, previous: LogEntry) => departsFrom(entry, previous),
});

type TokenRead =
  | {
    kind: "read"; read: AnchorRead; inscriptions: SatInscription[]; preIgnored: EvmStretch["ignored"]; block: { number: number; hash: string }; providers: string[]; holder: string | null;
    observed: EvmStretch["observed"]; times: Map<number, { timestamp: number; time: number }>; finality: EvmStretch["finality"]; records: EvmRecord[];
    /** The first record index read, and the checkpoint it resumes from (P9.25). */
    from: number; checkpoint: EvmCheckpoint | undefined;
    /** The greatest record timestamp read, s (P9.20). */
    latest: number;
    /** The lowest retained block number shown replaced (P9.22). */
    replacedFrom: number | undefined;
  }
  | { kind: "missing"; code: string; message: string; block: { number: number; hash: string } | null; providers: string[]; finality?: EvmStretch["finality"]; replacedFrom?: number | undefined }
  | { kind: "unsupported"; code: string; message: string };

function sameRecord(a: EvmRecord, b: EvmRecord): boolean {
  return a.index === b.index && a.timestamp === b.timestamp && a.metadataLength === b.metadataLength && a.bodyLength === b.bodyLength &&
    a.bodyOf === b.bodyOf && a.mediaType === b.mediaType && sameBytes(a.metadata, b.metadata) && sameBytes(a.body, b.body);
}

/**
 * Check and merge the providers' reads of one token (P9.21, P9.22), and turn
 * its records into inscriptions under the readings of P9.20 (P9.25, P14.20).
 */
function readToken(
  alias: string,
  listed: ListedChain,
  pin: EvmAnchorPin,
  supplied: EvmTokenEvidence[],
  retained: RetainedEvmBlock[],
  retainedCheckpoints: unknown[],
  excluded: EvmStretch["excludedProviders"],
): TokenRead {
  const checkpoints = retainedCheckpoints.filter(isEvmCheckpoint);
  const missing = (code: string, message: string, block: { number: number; hash: string } | null = null, providers: string[] = [], extra: { finality?: EvmStretch["finality"]; replacedFrom?: number | undefined } = {}): TokenRead =>
    ({ kind: "missing", code, message, block, providers, ...extra });
  const reads: EvmProviderRead[] = [];
  const stateUnavailable: string[] = [];
  const recordsUnread: string[] = [];
  for (const t of supplied) {
    // P9.20: never read an Original's publications from a chain other than the one its anchor names.
    if (t.chain !== listed.chain) {
      for (const r of t.reads) excluded.push({ provider: r.provider, reason: "other-chain" });
      continue;
    }
    for (const r of t.reads) {
      // P9.21: a chain ID alone does not identify a chain; block 0's hash must be the listed one.
      if (r.chainId !== listed.chainId) excluded.push({ provider: r.provider, reason: "wrong-chain-id" });
      else if (r.genesisHash.toLowerCase() !== listed.genesisHash) excluded.push({ provider: r.provider, reason: "wrong-genesis-hash" });
      // P9.22 (PR 59 1b5c484; owner decision, 13 November 2026): a provider that cannot serve the contract's
      // state at the finalized block, however far finality trails the head, or whose records at that block
      // could not be read with the pinned code there, is not usable: dropped, its answers not evidence.
      else if (r.stateUnavailable === true) {
        excluded.push({ provider: r.provider, reason: "state-unavailable" });
        stateUnavailable.push(r.provider);
      } else if (r.records === null && lower(r.codeHash) === pin.codeHash.toLowerCase()) {
        excluded.push({ provider: r.provider, reason: "state-unavailable" });
        recordsUnread.push(r.provider);
      } else reads.push(r);
    }
  }
  // P9.22: evidence is missing only when no usable provider remains.
  if (reads.length === 0) {
    if (stateUnavailable.length > 0) return missing("EVM_STATE_UNAVAILABLE", `no usable provider remains for ${alias}: ${stateUnavailable.join(", ")} cannot serve the anchor contract's state at the finalized block of ${listed.chain} (P9.22)`);
    if (recordsUnread.length > 0) return missing("EVM_RECORDS_UNREADABLE", `no usable provider remains for ${alias}: the records could not be read from state by ${recordsUnread.join(", ")} (P9.22, P9.25)`);
    return missing("EVM_NO_PROVIDER", `no provider serving ${listed.chain} (by chain ID and block 0) read ${alias} (P9.21)`);
  }
  // The usable providers the read comes from; a report names them, and marks a read one answered uncorroborated (P9.22).
  const providers = [...new Set(reads.map((r) => r.provider))];
  // P9.22: the lower of the usable providers' finalized blocks, read from every one of them. A read at any
  // other block, including the ahead provider's own finalized block, is not evidence for the comparison.
  // Usable providers that disagree leave the evidence missing: neither is dropped to settle it.
  const common = Math.min(...reads.map((r) => r.finalized));
  if (reads.some((r) => r.block.number !== common)) {
    return missing("EVM_READ_NOT_AT_FINALIZED", `every provider must be read at block ${common}, the lower of their finalized blocks; a read at another block is not evidence (P9.22)`, null, providers);
  }
  const block = { number: common, hash: reads[0].block.hash.toLowerCase() };
  if (reads.some((r) => r.block.hash.toLowerCase() !== block.hash)) {
    return missing("EVM_PROVIDERS_DISAGREE", `providers report different hashes for block ${common} (P9.22)`, null, providers);
  }

  // P9.22: finality is assumed; a retained finalized block, or a checkpoint's, that a provider now
  // reports with another hash is evidence that it was replaced: a finality failure, and every retained
  // result and checkpoint resting on it or a later block is discarded.
  let finality: EvmStretch["finality"] = "unchecked";
  const replaced: number[] = [];
  const relied = [...retained.filter((x) => x.chain === listed.chain), ...checkpoints.filter((c) => c.chain === listed.chain).map((c) => ({ chain: c.chain, ...c.block }))];
  for (const r of relied) {
    const seen = r.number === block.number ? block.hash : reads.flatMap((x) => x.blockHashes ?? []).find((h) => h.number === r.number)?.hash.toLowerCase();
    if (seen === undefined) continue;
    if (seen !== r.hash.toLowerCase()) {
      finality = "failed";
      replaced.push(r.number);
    } else if (finality !== "failed") finality = "held";
  }
  const replacedFrom = replaced.length > 0 ? Math.min(...replaced) : undefined;
  const at = { finality, replacedFrom };

  const codes = new Set(reads.map((r) => lower(r.codeHash)));
  if (codes.size > 1) return missing("EVM_PROVIDERS_DISAGREE", `providers report different code at the anchor contract address at block ${common} (P9.22)`, block, providers, at);
  const code = reads[0].codeHash?.toLowerCase() ?? null;
  // P9.21: other code, or none, at the address fixed for this chain is not an Originals anchor: unsupported.
  if (code !== pin.codeHash.toLowerCase()) {
    return { kind: "unsupported", code: "EVM_ANCHOR_CODE_MISMATCH", message: `the code at ${anchorAddress(pin, listed.chain)} on ${listed.chain} at block ${common} ${code === null ? "is absent" : `has hash ${code}`}, not the pinned ${pin.codeHash}: unsupported, never not anchored (P9.21)` };
  }
  if (new Set(reads.map((r) => lower(r.owner))).size > 1) return missing("EVM_PROVIDERS_DISAGREE", `providers report different ownerOf for ${alias} at block ${common} (P9.22)`, block, providers, at);
  const lists = reads.map((r) => r.records);
  if (lists.some((l) => l === null)) return missing("EVM_RECORDS_UNREADABLE", `the records of ${alias} could not be read from state at block ${common} (P9.25)`, block, providers, at);
  const records = lists[0]!;
  const froms = new Set(reads.map((r) => r.from ?? 0));
  if (froms.size > 1) return missing("EVM_PROVIDERS_DISAGREE", `providers read the records of ${alias} from different indexes (P9.25)`, block, providers, at);
  const from = [...froms][0];
  if (lists.some((l) => l!.length !== records.length || l!.some((r, k) => !sameRecord(r, records[k])))) {
    return missing("EVM_PROVIDERS_DISAGREE", `providers report different records or bytes for ${alias} at block ${common} (P9.22)`, block, providers, at);
  }
  if (records.some((r, k) => r.index !== from + k)) return missing("EVM_RECORDS_UNREADABLE", `the records of ${alias} are not every index from ${from} in order (P14.20)`, block, providers, at);
  // P9.25 (MAY): a read that starts after record 0 resumes from a retained checkpoint whose record
  // index is the one before it, at or below this block and not resting on a replaced block (P9.22).
  // Without one, the earlier records are unread: missing evidence, never decided on the part read.
  let checkpoint: EvmCheckpoint | undefined;
  if (from > 0) {
    checkpoint = checkpoints.find((c) => checkpointAlias(c) === alias && c.chain === listed.chain && c.record + 1 === from && c.block.number <= common && (replacedFrom === undefined || c.block.number < replacedFrom));
    if (!checkpoint) return missing("EVM_RECORDS_UNREADABLE", `the records of ${alias} before index ${from} were not read, and no retained checkpoint covers them (P9.25)`, block, providers, at);
  }

  // P9.20, P9.25, P14.20: records as inscriptions, height = index; inscription time the greatest timestamp so far.
  const inscriptions: SatInscription[] = [];
  const preIgnored: EvmStretch["ignored"] = [];
  const times = new Map<number, { timestamp: number; time: number }>();
  for (const p of checkpoint ? [checkpoint.anchor, ...checkpoint.accepted, ...checkpoint.conflicting] : []) times.set(p.index, { timestamp: p.timestamp, time: p.time });
  const byIndex = new Map(records.map((r) => [r.index, r]));
  let latest = checkpoint?.latest ?? 0;
  for (const rec of records) {
    latest = Math.max(latest, rec.timestamp);
    times.set(rec.index, { timestamp: rec.timestamp, time: latest * 1000 });
    // Decided from the record's own fields, without reading its bytes; never missing evidence (P9.25).
    if (utf8Length(rec.mediaType) > MEDIA_TYPE_MAX_BYTES) {
      preIgnored.push({ index: rec.index, reason: "media-type-too-long" });
      continue;
    }
    const stored = rec.bodyOf === rec.index;
    // P14.20 (PR 59 a3ffdc1): a publication counts the bytes it newly stores, so a record that refers
    // to an earlier body counts its metadata only.
    if ((stored ? rec.metadataLength + rec.bodyLength : rec.metadataLength) > ORIGINALS_INSCRIPTION_MAX_BYTES) {
      preIgnored.push({ index: rec.index, reason: "too-large" });
      continue;
    }
    // P14.20: `bodyOf` is an earlier record of this token that stored its own body, and a referring
    // record holds that body's actual length as its `bodyLength`. The pinned contract records nothing
    // else. A referred record before a resumed read was checked when the checkpoint was made.
    const referred = stored ? rec : byIndex.get(rec.bodyOf);
    if (!stored && (rec.bodyOf > rec.index || (referred === undefined && rec.bodyOf >= from) ||
      (referred !== undefined && (referred.bodyOf !== referred.index || referred.bodyLength !== rec.bodyLength)))) {
      preIgnored.push({ index: rec.index, reason: "invalid-body-reference" });
      continue;
    }
    const body = rec.body ?? (stored ? undefined : referred?.body);
    if (rec.metadata === undefined || body === undefined) {
      return missing("EVM_RECORD_BYTES_UNREAD", `the bytes of record ${rec.index} of ${alias} were not read from state (P9.25)`, block, providers, at);
    }
    if (rec.metadata.length !== rec.metadataLength || body.length !== rec.bodyLength) {
      return missing("EVM_RECORD_BYTES_UNREAD", `the bytes read for record ${rec.index} of ${alias} are not the lengths it records (P14.20)`, block, providers, at);
    }
    inscriptions.push({
      id: `${alias}#${rec.index}`, sat: alias, network: "mainnet", height: rec.index, transactionIndex: 0, inscriptionIndex: 0,
      confirmations: 1, inscriptionTime: latest * 1000, mediaType: rec.mediaType, content: body, metadata: rec.metadata,
    });
  }
  const count = from + records.length;
  const observed = [...new Map(reads.flatMap((r) => r.observed ?? []).filter((o) => o.index >= count).map((o) => [o.index, { index: o.index, timestamp: o.timestamp }])).values()]
    .sort((a, b) => a.index - b.index);
  const holder = lower(reads[0].owner);
  const read: AnchorRead = { alias: { did: alias }, indexes: providers, tip: { height: block.number, hash: block.hash }, inscriptions, excluded: [], disputed: [], owner: null, ownerDisputed: false };
  return { kind: "read", read, inscriptions, preIgnored, block, providers, holder, observed, times, finality, records, from, checkpoint, latest, replacedFrom };
}

const indexOf = (id: string) => Number(id.slice(id.lastIndexOf("#") + 1));


/** The index of the first anchoring entry of `copy`, on any chain or Bitcoin, or -1 (P7.14). */
function firstAnchoring(copy: unknown[]): number {
  return copy.findIndex((e) => tokenNamedBy(e) !== undefined || (assetOf(e)?.aliases ?? []).some((a) => typeof a === "string" && a.startsWith("did:btco:")));
}

/** The entries before the first anchoring entry of `copy`, or all of it when it has none (P7.14). */
function beforeFirstAnchoring(copy: unknown[] | null): unknown[] {
  if (!copy) return [];
  const k = firstAnchoring(copy);
  return k < 0 ? copy : copy.slice(0, k);
}

/** The versionIds of `copy` from its first anchoring entry on: not checked against the current anchor (P7.14, P9.29). */
function fromFirstAnchoring(copy: unknown[] | null): string[] {
  if (!copy) return [];
  const k = firstAnchoring(copy);
  return k < 0 ? [] : copy.slice(k).flatMap((e) => (typeof (e as LogEntry | null)?.versionId === "string" ? [(e as LogEntry).versionId] : []));
}

/** Whether P14.19 derives the token `alias` names from the Original `did` and its `anchor` member, at the address P14.21 fixes (P3.9). */
function derivesToken(alias: string, did: string, anchor: EvmAnchor, pin: EvmAnchorPin | null): boolean {
  let t;
  try {
    t = parseEvmAlias(alias);
  } catch (error) {
    if (error instanceof OriginalsError) return false;
    throw error;
  }
  return t.chain === anchor.chain && t.tokenId === tokenIdOf(did, anchor.minter) && (pin === null || t.contract === anchorAddress(pin, anchor.chain));
}

/**
 * P3.9 (PR 59 a3ffdc1): with no copy of the log, the candidate Original comes
 * from an anchoring or arrival publication on a token: one whose last entry
 * lists that token's alias and whose genesis entry, with that last entry's
 * `anchor` member, derives the token (P14.19). Any other record, including
 * the token's first, decides nothing. The candidate is then verified like
 * any log; this only chooses which Original to verify. With `resolving`, only
 * that token's records are searched.
 */
export function evmCandidate(evidence: Pick<EvmEvidence, "tokens" | "pin" | "resolving">): LogEntry | undefined {
  for (const t of evidence.tokens) {
    if (evidence.resolving !== undefined && t.alias !== evidence.resolving) continue;
    for (const r of t.reads) {
      for (const rec of r.records ?? []) {
        const carried = readInscribedEntries(rec.metadata);
        if (carried.kind !== "entries") continue;
        const first = carried.entries[0];
        const last = carried.entries[carried.entries.length - 1];
        if (tokenNamedBy(last) !== t.alias) continue;
        const did = (first?.state as { id?: unknown } | undefined)?.id;
        const anchor = anchorOf(last);
        if (typeof did !== "string" || !anchor || !derivesToken(t.alias, did, anchor, evidence.pin)) continue;
        return first;
      }
    }
  }
  return undefined;
}

/** The genesis entry: the copy's, or the candidate's (P3.9). */
function genesisOf(copy: unknown[] | null, evidence: EvmEvidence): unknown {
  if (copy && copy.length > 0) return copy[0];
  return evmCandidate(evidence);
}

/** The versionIds of the entries before the first anchoring entry, when there is one (P9.29). */
function carriedOf(entries: unknown[]): string[] {
  const k = beforeFirstAnchoring(entries).length;
  return k < entries.length ? entries.slice(0, k).map((e) => (e as LogEntry).versionId) : [];
}

/**
 * Assemble an Original whose genesis entry has an `anchor` member (P9.19)
 * from its tokens, following each move (P9.29), and from Bitcoin when it
 * moved there. Returns null for an Original without an `anchor` member.
 *
 * `moveTimes` is filled with each single-entry publication's record
 * timestamp (ms), by versionId, before the log is verified, so the state
 * rules judge a move's layers by the classes that applied at its departure
 * record (P9.28).
 */
export async function assembleFromEvm(
  copy: unknown[] | null,
  evidence: EvmEvidence,
  bitcoin: SatEvidence[],
  verify: Verify,
  histories: AuthorHistory[],
  options: { previousAnchor?: RetainedAnchor; previousHead?: string; moveTimes: Map<string, number> },
): Promise<EvmAssembly | null> {
  const genesis = genesisOf(copy, evidence);
  const empty = (report: EvmAnchoringReport, entries: unknown[] = []): EvmAssembly =>
    ({ entries, report, bitcoin: null, bytes: new Map(), rejectedByAuthorState: new Set(), retainedBlocks: [], checkpoints: [], replaced: [] });
  const bare = (status: EvmAnchoringReport["status"]): EvmAnchoringReport =>
    ({ status, move: "none", stretches: [], owner: null, destination: null, arrival: null, carried: { entries: [], ordering: "claimed" }, unsupported: null, warnings: [], notCheckedAgainstAnchor: [], localCopy: false });
  // P3.9, P9.23: tokens with no anchoring or arrival publication of any Original, whatever was minted
  // or whatever `tokenURI` says, show no Original.
  if (genesis === undefined && (!copy || copy.length === 0) && evidence.tokens.length > 0) return empty(bare("not-anchored"));
  const genesisAnchor = assetOf(genesis)?.anchor;
  if (genesisAnchor === undefined) return null;
  const did = (genesis as { state?: { id?: unknown } }).state?.id;
  let anchor = anchorOf(genesis);
  if (!anchor || typeof did !== "string") {
    // A malformed anchor member is the log's failure (P14.18); verify the copy and let it report it.
    return empty(bare("unverified"), copy ?? []);
  }
  const pin = evidence.pin;

  const stretches: EvmStretch[] = [];
  const bytes = new Map<string, { bytes: Uint8Array; chain: string }>();
  const rejectedByAuthorState = new Set<string>();
  const retainedBlocks: RetainedEvmBlock[] = [];
  const checkpoints: EvmCheckpoint[] = [];
  const replaced: EvmAssembly["replaced"] = [];
  const warnings: EvmAnchoringReport["warnings"] = [];
  let move: EvmAnchoringReport["move"] = "none";
  let arrival: LogEntry[] | "unconfirmed" | undefined;
  /** The entries accepted through the last departure, when there was one (P9.29). */
  let throughDeparture: LogEntry[] | null = null;
  let retainedAnchor: RetainedAnchor | undefined;
  const finish = (status: EvmAnchoringReport["status"], entries: unknown[], extra: Partial<EvmAnchoringReport> = {}, btc: Assembly | null = null): EvmAssembly => {
    const last = stretches[stretches.length - 1];
    const ownerOk = status === "anchored" && move !== "unconfirmed" && last?.holder !== null && last?.block !== null && last?.finality !== "failed";
    const owner: EvmOwnership | null = ownerOk && last ? {
      describes: last.describes, chain: last.chain, class: last.class, token: last.token, address: last.holder!, block: last.block!, providers: last.providers, uncorroborated: last.uncorroborated,
    } : null;
    const moved = move !== "none" || arrival !== undefined;
    const arrivalStatus: EvmAnchoringReport["arrival"] = !moved ? null : status === "anchored" || status === "moved-to-bitcoin" ? "arrived" : status === "departed-not-arrived" ? "not-arrived" : "unknown";
    return {
      entries,
      report: {
        status, move, stretches, owner, destination: null, arrival: arrivalStatus,
        // P9.29: the entries before the first anchoring entry are carried, with claimed ordering, after any number of moves.
        carried: { entries: carriedOf(entries), ordering: "claimed" },
        unsupported: null, warnings, notCheckedAgainstAnchor: [], localCopy: false, ...extra,
      },
      bitcoin: btc,
      bytes,
      rejectedByAuthorState,
      ...(retainedAnchor ? { retainedAnchor } : {}),
      retainedBlocks,
      checkpoints,
      replaced,
    };
  };
  /**
   * P7.14, P9.29: evidence missing for the chain the Original is anchored on now: at most the entries
   * before the first anchoring entry, the rest reported as not checked against the current anchor.
   */
  const limited = (source: unknown[] | null, extra: Partial<EvmAnchoringReport> = {}, btc: Assembly | null = null): EvmAssembly =>
    finish("unverified", beforeFirstAnchoring(source), { ...extra, notCheckedAgainstAnchor: fromFirstAnchoring(source) }, btc);
  const unsupported = (code: string, message: string, chain: string, entries: unknown[] = []): EvmAssembly =>
    ({ ...empty({ ...bare("unsupported"), stretches, unsupported: { code, message, chain } }, entries), replaced });

  for (;;) {
    // P9.19, P9.21, section 14: no pin, or an unlisted chain, is unsupported, never invalid.
    const support = evmSupport(anchor.chain, pin);
    if (!support.supported) {
      const code = support.reason === "chain-not-listed" ? "EVM_CHAIN_NOT_LISTED" : "EVM_NO_ANCHOR_CONTRACT";
      const message = support.reason === "chain-not-listed"
        ? `${anchor.chain} is not in this verifier's revision of P14.22: unsupported, not invalid (P9.19)`
        : "P14.21 pins no anchor contract: an Original with an anchor member is unsupported, not invalid (section 14)";
      return unsupported(code, message, anchor.chain);
    }
    const { listed } = support;
    const alias = derivedTokenAlias(did, anchor, support.pin);
    const cls = currentClass(listed);
    const excluded: EvmStretch["excludedProviders"] = [];
    const supplied = evidence.tokens.filter((t) => t.alias === alias);
    let token = readToken(alias, listed, support.pin, supplied, evidence.retained ?? [], evidence.checkpoints ?? [], excluded);
    if (token.kind === "unsupported") return unsupported(token.code, token.message, anchor.chain);
    // P9.22: evidence of a replaced block is a warning, whatever else the read shows.
    const replacedFrom = token.kind === "read" ? token.replacedFrom : token.replacedFrom;
    if (replacedFrom !== undefined) {
      replaced.push({ chain: listed.chain, from: replacedFrom });
      if (!warnings.includes("authoritative-source-changed")) warnings.push("authoritative-source-changed");
    }
    // P9.25: resuming needs a supplied log whose entry N is the checkpoint's head; with another, the
    // checkpoint is not resumed from, and a read that resumed anyway leaves the earlier records unread.
    let resume: ReturnType<typeof resumeFrom> = null;
    if (token.kind === "read" && token.checkpoint) {
      resume = resumeFrom(alias, token.checkpoint, copy ?? (Array.isArray(arrival) ? arrival : null));
      if (!resume) {
        token = {
          kind: "missing", code: "EVM_CHECKPOINT_UNUSABLE",
          message: `the read of ${alias} resumes after record ${token.checkpoint.record}, but the supplied log's entry ${versionNumber(token.checkpoint.head)} is not the checkpoint's head ${token.checkpoint.head}: not resumed from; read the token from its first record (P9.25)`,
          block: token.block, providers: token.providers, finality: token.finality,
        };
      }
    }
    const stretch: EvmStretch = {
      chain: listed.chain, name: listed.name, class: cls, ordering: "claimed", layer: layerOfClass(cls), describes: describeClass(cls), token: alias, caip19: caip19Of(alias),
      status: "unverified", arrival: arrival !== undefined, anchor: null, conflicting: [], accepted: [], entries: [], carried: [], departure: null,
      ignored: [], unverifiable: [], observed: [], block: token.block, providers: token.providers, uncorroborated: token.providers.length === 1, excludedProviders: excluded, holder: null,
      finality: token.kind === "read" ? token.finality : token.finality ?? "unchecked", uniqueness: { status: "not-established" }, change: null, headChange: null,
    };
    stretches.push(stretch);

    if (token.kind === "missing") {
      stretch.missing = { code: token.code, message: token.message };
      // The caller's own committed log with no token read at all: verified whole, unverified on the
      // chain and never current (P9.18 through P9.20), as Bitcoin's assembly treats a log with no reads.
      if (evidence.localCopy === true && evidence.tokens.length === 0 && bitcoin.length === 0 && copy) return finish("unverified", copy, { localCopy: true, notCheckedAgainstAnchor: fromFirstAnchoring(copy) });
      // P9.29: a chain the Original left that cannot be read leaves the move unconfirmed, and the
      // log the arrival carries is still verified, its proofs and hash links checked from genesis.
      // Which move left it is known only from the copy.
      const k = copy ? copy.findIndex((e, j) => j > 0 && tokenNamedBy(copy[j - 1]) === alias && departsFrom(e as LogEntry, copy[j - 1] as LogEntry)) : -1;
      const next = k >= 0 ? anchorOf(copy![k]) : undefined;
      const btcoNext = k >= 0 && next === undefined;
      const destinationSupplied = next ? evidence.tokens.some((t) => t.chain === next.chain) : btcoNext && bitcoin.length > 0;
      if (k >= 0 && destinationSupplied) {
        // P9.29 (PR 59 a3ffdc1): the entries accepted on the unread chain, by the copy, have claimed
        // ordering only: neither attested nor proven without that chain's evidence.
        const named = copy!.flatMap((e, j) => (tokenNamedBy(e) === alias && j < k ? [j] : []));
        stretch.entries = [...(arrival !== undefined ? named.slice(1) : named), k].map((j) => (copy![j] as LogEntry).versionId);
        stretch.ordering = "claimed";
        move = "unconfirmed";
        arrival = "unconfirmed";
        if (next) {
          anchor = next;
          continue;
        }
        return toBitcoin(copy!.slice(0, k + 1) as LogEntry[]);
      }
      // P9.29 (PR 59 1b5c484): a final departure whose destination cannot be read is reported as
      // finalized, the destination as unreachable, with missing evidence, claiming no arrival and no
      // lack of one. P7.14: without the chain it is anchored on now, at most the entries before the
      // first anchoring entry; the anchoring entry and later ones, through the move entry, are not
      // checked against the current anchor though the chain left accepted them; no owner, nothing current.
      if (arrival !== undefined) return limited(copy ?? throughDeparture, { destination: alias });
      return limited(copy ?? throughDeparture);
    }

    // P9.28: a move's layers are judged at its departure record's timestamp; record it before verifying.
    // Every entry a record carries gets the record's timestamp; the first record carrying it wins.
    for (const i of token.inscriptions) {
      const carried = readInscribedEntries(i.metadata);
      if (carried.kind !== "entries") continue;
      const versionId = carried.entries[carried.entries.length - 1]?.versionId;
      if (typeof versionId === "string" && !options.moveTimes.has(versionId)) options.moveTimes.set(versionId, token.times.get(i.height)!.timestamp * 1000);
    }
    for (const p of token.checkpoint ? token.checkpoint.accepted : []) if (!options.moveTimes.has(p.versionId)) options.moveTimes.set(p.versionId, p.timestamp * 1000);
    const previousAnchor = options.previousAnchor?.sat === alias ? options.previousAnchor : undefined;
    const core = await assembleAnchored(copy ?? (Array.isArray(arrival) ? arrival : null), [token.read], token.inscriptions, verify, histories, {
      ...(previousAnchor ? { previousAnchor } : {}),
      ...(previousAnchor && options.previousHead !== undefined ? { previousHead: options.previousHead } : {}),
      ...(arrival ? { arrival } : {}),
      ...(resume ? { resume } : {}),
    }, EVM_KIND);
    for (const v of core.rejectedByAuthorState) rejectedByAuthorState.add(v);
    const placedOf = (p: { inscription: string; versionId: string }): EvmPlaced => {
      const index = indexOf(p.inscription);
      const t = token.times.get(index)!;
      return { token: alias, index, versionId: p.versionId, timestamp: t.timestamp, inscriptionTime: t.time };
    };
    stretch.block = token.block;
    stretch.holder = token.holder;
    stretch.finality = token.finality;
    stretch.observed = token.observed;
    if (token.checkpoint) stretch.resumedFrom = { head: token.checkpoint.head, record: token.checkpoint.record, block: token.checkpoint.block };
    stretch.ignored = [
      ...token.preIgnored,
      ...core.report.ignored.map((x) => ({
        index: indexOf(x.inscription), ...(x.versionId ? { versionId: x.versionId } : {}), reason: x.reason, ...(x.code ? { code: x.code } : {}),
        ...(x.waitingOn ? { waitingOn: indexOf(x.waitingOn) } : {}),
      })),
      ...token.observed.map((o) => ({ index: o.index, reason: "observed-not-finalized" as const })),
    ].sort((a, b) => a.index - b.index);
    stretch.unverifiable = core.report.unverifiable.map((u) => ({ index: indexOf(u.inscription), ...(u.versionId ? { versionId: u.versionId } : {}), signer: u.signer, signerVersionId: u.signerVersionId }));
    stretch.change = core.report.change;
    stretch.headChange = core.report.headChange;
    retainedBlocks.push({ chain: listed.chain, number: token.block.number, hash: token.block.hash });

    // P9.28: a move entry to an unlisted chain is unsupported, not invalid; it is not a departure.
    const unlisted = stretch.ignored.find((x) => x.code === "EVM_CHAIN_NOT_LISTED");
    if (unlisted) {
      stretch.status = core.report.status === "anchored" ? "anchored" : "not-anchored";
      return unsupported("EVM_CHAIN_NOT_LISTED", `the move entry ${unlisted.versionId ?? ""} names a destination this verifier's revision of P14.22 does not list: unsupported, not invalid (P9.19, P9.28)`, anchor.chain, core.entries);
    }

    if (core.report.status !== "anchored") {
      stretch.status = "not-anchored";
      if (arrival !== undefined) {
        // P9.29: departed, not arrived, with the move entry's state and no owner. Unconfirmed
        // when the chain left was not read: the log is then what the copy shows through the move.
        if (arrival === "unconfirmed") return limited(copy);
        return finish("departed-not-arrived", throughDeparture!, { destination: alias });
      }
      // P9.19, P9.23: a signed anchoring entry not published, a genesis anchor member alone, or a
      // token minted with no valid anchoring publication: not anchored, no owner.
      return finish("not-anchored", core.entries);
    }

    stretch.status = "anchored";
    stretch.ordering = stretch.describes;
    const anchorPlaced = placedOf(core.report.anchor!);
    stretch.anchor = anchorPlaced;
    stretch.conflicting = core.report.conflicting.map(placedOf);
    stretch.accepted = core.report.accepted.map(placedOf);
    const head = core.entries as LogEntry[];
    const anchorAt = head.findIndex((e) => e.versionId === anchorPlaced.versionId);
    stretch.carried = head.slice(0, arrival !== undefined ? anchorAt + 1 : anchorAt).map((e) => e.versionId);
    stretch.entries = [...(arrival !== undefined ? [] : [anchorPlaced.versionId]), ...stretch.accepted.map((a) => a.versionId)];
    // P9.24 (MAY; PR 59 a3ffdc1): uniqueness in the terms of the class, only under this chain's
    // finality and the providers used; none after a finality failure.
    // P9.24 (1b5c484): after a finality failure, not established whatever the class.
    stretch.uniqueness = token.finality === "failed"
      ? { status: "not-established" }
      : { status: uniquenessStatus(cls), chain: listed.chain, class: cls, block: token.block, providers: token.providers, uncorroborated: stretch.uncorroborated };
    for (const [digest, b] of core.bytes) bytes.set(digest, { bytes: b, chain: listed.chain });
    retainedAnchor = { inscription: core.report.anchor!.inscription, sat: alias, owner: token.holder };
    // P9.25 (1b5c484): a checkpoint at this read: the head entry's versionId, with the chain, the token,
    // the index of the record that accepted the head, the finalized block and the class at it. None while
    // a publication waits on an unverifiable entry (P9.15; owner decision, 13 November 2026); none either
    // while an unverifiable one has nothing waiting on it, or after a finality failure (P9.22).
    if (token.finality !== "failed" && core.report.unverifiable.length === 0) {
      const at = (p: EvmPlaced): EvmCheckpointPlacement => ({ index: p.index, versionId: p.versionId, timestamp: p.timestamp, time: p.inscriptionTime });
      const accepting = stretch.accepted[stretch.accepted.length - 1] ?? anchorPlaced;
      const t = parseEvmAlias(alias);
      checkpoints.push({
        head: head[head.length - 1].versionId, chain: listed.chain, contract: t.contract, tokenId: t.tokenId.toString(), record: accepting.index,
        block: token.block, class: cls,
        arrival: arrival !== undefined, anchor: at(anchorPlaced), accepted: stretch.accepted.map(at),
        conflicting: stretch.conflicting.filter((c) => c.index <= accepting.index).map(at),
        latest: token.times.get(accepting.index)!.time / 1000, departed: core.departure !== undefined,
      });
    }
    if (token.finality === "failed" && throughDeparture) move = "unconfirmed";

    if (!core.departure) return finish("anchored", head);

    // P9.29: departed. The move entry is the head; the next anchor is its `anchor` member, or Bitcoin.
    const departure = placedOf(core.departure);
    const moveEntry = head[head.length - 1];
    const next = anchorOf(moveEntry);
    const at = departure.timestamp * 1000;
    stretch.classAtDeparture = classAt(listed, at);
    stretch.departure = { ...departure, destination: next ? derivedTokenAlias(did, next, support.pin) : (assetOf(moveEntry)?.aliases ?? []).find((a) => a.startsWith("did:btco:")) ?? "" };
    // P9.29: a chain left whose departure block was replaced leaves the move unconfirmed.
    if (token.finality === "failed") move = "unconfirmed";
    else if (move === "none") move = "confirmed";
    throughDeparture = head;
    arrival = head;
    if (next) {
      anchor = next;
      continue;
    }
    return toBitcoin(head);
  }

  /** P9.28, P9.29: the arrival on Bitcoin is the anchoring inscription on the destination sat. */
  async function toBitcoin(through: LogEntry[]): Promise<EvmAssembly> {
    const btc = await assembleFromBitcoin(copy ?? through, bitcoin, verify, histories, {
      arrival: arrival === "unconfirmed" ? "unconfirmed" : through,
      ...(options.previousAnchor && !options.previousAnchor.sat.startsWith("did:evm:") ? { previousAnchor: options.previousAnchor } : {}),
      ...(options.previousAnchor && !options.previousAnchor.sat.startsWith("did:evm:") && options.previousHead !== undefined ? { previousHead: options.previousHead } : {}),
    });
    for (const v of btc.rejectedByAuthorState) rejectedByAuthorState.add(v);
    // `through` only selects the Original and names the sat when no copy was supplied: the report
    // compares a supplied copy, so without one it names none (section 7, reports stay separate).
    if (!copy) btc.report = { ...btc.report, copy: "absent", superseded: 0 };
    if (btc.report.status === "anchored") return finish("moved-to-bitcoin", btc.entries, {}, btc);
    const destination = (assetOf(through[through.length - 1])?.aliases ?? []).find((a) => a.startsWith("did:btco:")) ?? null;
    // P9.29: a final departure whose destination sat cannot be read: unreachable, no arrival claimed or denied.
    if (btc.report.status === "unverified") return limited(copy ?? through, { destination }, btc);
    if (arrival === "unconfirmed") return limited(copy ?? through, {}, btc);
    return finish("departed-not-arrived", through, { destination }, btc);
  }
}

/**
 * P9.25: what `assembleAnchored` needs to resume from a checkpoint: the
 * supplied log through entry N, which must be the checkpoint's head and hold
 * its anchor and every entry accepted after it, in order. Entries after line
 * N are not evidence. Null when the log cannot supply that.
 */
function resumeFrom(alias: string, cp: EvmCheckpoint, source: unknown[] | null): NonNullable<Parameters<typeof assembleAnchored>[5]["resume"]> | null {
  if (!source) return null;
  const n = versionNumber(cp.head);
  if (n === undefined || (source[n - 1] as LogEntry | null | undefined)?.versionId !== cp.head) return null;
  const entries = source.slice(0, n) as LogEntry[];
  const anchorEntries = entries.findIndex((e) => e.versionId === cp.anchor.versionId) + 1;
  if (anchorEntries === 0) return null;
  const after = entries.slice(anchorEntries).map((e) => e.versionId);
  if (after.length !== cp.accepted.length || after.some((v, k) => v !== cp.accepted[k].versionId)) return null;
  const placed = (p: EvmCheckpointPlacement): Placed => ({ sat: alias, inscription: `${alias}#${p.index}`, versionId: p.versionId, height: p.index, confirmations: 1, inscriptionTime: p.time });
  return {
    entries,
    anchorEntries,
    anchor: {
      id: `${alias}#${cp.anchor.index}`, sat: alias, network: "mainnet", height: cp.anchor.index, transactionIndex: 0, inscriptionIndex: 0,
      confirmations: 1, inscriptionTime: cp.anchor.time, mediaType: "", content: new Uint8Array(0),
    },
    accepted: cp.accepted.map(placed),
    conflicting: cp.conflicting.map(placed),
    departed: cp.departed,
  };
}
