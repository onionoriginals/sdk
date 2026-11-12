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
 * - P9.22: the reads are at the lower of the providers' finalized blocks;
 *   providers that disagree on that block's hash or on the state at it leave
 *   the evidence missing. Records above it are observed, never accepted. A
 *   retained finalized block that the chain has replaced is a finality failure
 *   with `authoritative-source-changed`.
 * - P9.23: the owner is `ownerOf` at that block, only once anchored.
 * - P9.25, P14.20: a record over the limits is rejected from its fields,
 *   without its bytes, and never makes evidence missing; any other record
 *   whose bytes were not read does.
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
   * P9.25 (PR 59 a3ffdc1, MAY): verified checkpoints this verifier retained
   * (`OriginalsReport.retain.evmCheckpoints`). A read whose `from` is a
   * checkpoint's `records` resumes from it; one resting on a block the chain
   * replaced is discarded (P9.22).
   */
  checkpoints?: EvmCheckpoint[];
  /**
   * P3.9: the did:evm alias being resolved with no copy of the log. The
   * candidate Original is then taken only from an anchoring or arrival
   * publication on that token. Without it and without a copy, from such a
   * publication on any supplied token.
   */
  resolving?: string;
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

export type ProviderExclusion = "wrong-chain-id" | "wrong-genesis-hash" | "other-chain";

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
  providers: string[];
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
  /** P9.25: the retained checkpoint this read resumed from, reading only later records. */
  resumedFrom?: { records: number; block: { number: number; hash: string } };
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

/** P9.24 (PR 59 a3ffdc1): uniqueness in the terms of the chain's class. */
export type EvmUniqueness =
  | {
    status: "established" | "attested-by-operator" | "attested-by-validators";
    chain: string;
    class: TrustClass;
    /** It holds only under the chain's finality and these providers' reads at this block. */
    block: { number: number; hash: string };
    providers: string[];
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
  checkpoints: EvmCheckpoint[],
  excluded: EvmStretch["excludedProviders"],
): TokenRead {
  const missing = (code: string, message: string, block: { number: number; hash: string } | null = null, providers: string[] = [], extra: { finality?: EvmStretch["finality"]; replacedFrom?: number | undefined } = {}): TokenRead =>
    ({ kind: "missing", code, message, block, providers, ...extra });
  const reads: EvmProviderRead[] = [];
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
      else reads.push(r);
    }
  }
  if (reads.length === 0) return missing("EVM_NO_PROVIDER", `no provider serving ${listed.chain} (by chain ID and block 0) read ${alias} (P9.21)`);
  const providers = [...new Set(reads.map((r) => r.provider))];
  // P9.22 (PR 59 a3ffdc1): a provider that cannot serve the contract's state at the finalized block,
  // however far finality trails the head, is not usable for that read, and its failure is missing evidence.
  const unavailable = reads.find((r) => r.stateUnavailable === true);
  if (unavailable) {
    return missing("EVM_STATE_UNAVAILABLE", `${unavailable.provider} cannot serve the anchor contract's state at the finalized block of ${listed.chain}: not usable for this read (P9.22)`, null, providers);
  }
  // P9.22: the lower of the providers' finalized blocks, read from every provider. A read at any other
  // block, including the ahead provider's own finalized block, is not evidence for the comparison.
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
  // P9.25 (MAY): a read that starts after record 0 resumes from a retained checkpoint at that index,
  // at or below this block and not resting on a replaced block (P9.22). Without one, the earlier
  // records are unread: missing evidence, never decided on the part read.
  let checkpoint: EvmCheckpoint | undefined;
  if (from > 0) {
    checkpoint = checkpoints.find((c) => c.token === alias && c.chain === listed.chain && c.records === from && c.block.number <= common && (replacedFrom === undefined || c.block.number < replacedFrom));
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


/** The entries before the first anchoring entry of `copy`, or all of it when it has none (P7.14). */
function beforeFirstAnchoring(copy: unknown[] | null): unknown[] {
  if (!copy) return [];
  const k = copy.findIndex((e) => tokenNamedBy(e) !== undefined || (assetOf(e)?.aliases ?? []).some((a) => typeof a === "string" && a.startsWith("did:btco:")));
  return k < 0 ? copy : copy.slice(0, k);
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
    ({ status, move: "none", stretches: [], owner: null, destination: null, arrival: null, carried: { entries: [], ordering: "claimed" }, unsupported: null, warnings: [] });
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
      describes: last.describes, chain: last.chain, class: last.class, token: last.token, address: last.holder!, block: last.block!, providers: last.providers,
    } : null;
    const moved = move !== "none" || arrival !== undefined;
    const arrivalStatus: EvmAnchoringReport["arrival"] = !moved ? null : status === "anchored" || status === "moved-to-bitcoin" ? "arrived" : status === "departed-not-arrived" ? "not-arrived" : "unknown";
    return {
      entries,
      report: {
        status, move, stretches, owner, destination: null, arrival: arrivalStatus,
        // P9.29: the entries before the first anchoring entry are carried, with claimed ordering, after any number of moves.
        carried: { entries: carriedOf(entries), ordering: "claimed" },
        unsupported: null, warnings, ...extra,
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
    // P9.25: resuming needs the checkpoint's head in a copy of the log; without it the earlier records are unread.
    let resume: ReturnType<typeof resumeFrom> = null;
    if (token.kind === "read" && token.checkpoint) {
      resume = resumeFrom(alias, token.checkpoint, copy ?? (Array.isArray(arrival) ? arrival : null));
      if (!resume) {
        token = { kind: "missing", code: "EVM_CHECKPOINT_UNUSABLE", message: `the read of ${alias} resumes from record ${token.from}, but no copy of the log holds the checkpoint's head ${token.checkpoint.head} (P9.25)`, block: token.block, providers: token.providers, finality: token.finality };
      }
    }
    const stretch: EvmStretch = {
      chain: listed.chain, name: listed.name, class: cls, ordering: "claimed", layer: layerOfClass(cls), describes: describeClass(cls), token: alias, caip19: caip19Of(alias),
      status: "unverified", arrival: arrival !== undefined, anchor: null, conflicting: [], accepted: [], entries: [], carried: [], departure: null,
      ignored: [], unverifiable: [], observed: [], block: token.block, providers: token.providers, excludedProviders: excluded, holder: null,
      finality: token.kind === "read" ? token.finality : token.finality ?? "unchecked", uniqueness: { status: "not-established" }, change: null, headChange: null,
    };
    stretches.push(stretch);

    if (token.kind === "missing") {
      stretch.missing = { code: token.code, message: token.message };
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
      // P9.29 (PR 59 a3ffdc1): a final departure whose destination cannot be read is reported as
      // finalized, the destination as unreachable, with missing evidence, claiming no arrival and no
      // lack of one. P7.14: without the chain it is anchored on now, at most the entries before the
      // first anchoring entry.
      if (arrival !== undefined) return finish("unverified", beforeFirstAnchoring(copy ?? throughDeparture), { destination: alias });
      return finish("unverified", beforeFirstAnchoring(copy ?? throughDeparture));
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
    if (token.checkpoint) stretch.resumedFrom = { records: token.checkpoint.records, block: token.checkpoint.block };
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
        if (arrival === "unconfirmed") return finish("unverified", beforeFirstAnchoring(copy));
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
    stretch.uniqueness = token.finality === "failed"
      ? { status: "not-established" }
      : { status: uniquenessStatus(cls), chain: listed.chain, class: cls, block: token.block, providers: token.providers };
    for (const [digest, b] of core.bytes) bytes.set(digest, { bytes: b, chain: listed.chain });
    retainedAnchor = { inscription: core.report.anchor!.inscription, sat: alias, owner: token.holder };
    // P9.25: a verified checkpoint at this read, unless something is waiting on an unverifiable
    // publication (P9.15), which a resumed read could not take up again, or finality failed (P9.22).
    if (token.finality !== "failed" && core.report.unverifiable.length === 0) {
      const at = (p: EvmPlaced): EvmCheckpointPlacement => ({ index: p.index, versionId: p.versionId, timestamp: p.timestamp, time: p.inscriptionTime });
      checkpoints.push({
        chain: listed.chain, token: alias, records: token.from + token.records.length, block: token.block, head: head[head.length - 1].versionId,
        arrival: arrival !== undefined, anchor: at(anchorPlaced), accepted: stretch.accepted.map(at), conflicting: stretch.conflicting.map(at),
        latest: token.latest, departed: core.departure !== undefined,
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
    if (btc.report.status === "anchored") return finish("moved-to-bitcoin", btc.entries, {}, btc);
    const destination = (assetOf(through[through.length - 1])?.aliases ?? []).find((a) => a.startsWith("did:btco:")) ?? null;
    // P9.29: a final departure whose destination sat cannot be read: unreachable, no arrival claimed or denied.
    if (btc.report.status === "unverified") return finish("unverified", beforeFirstAnchoring(copy ?? through), { destination }, btc);
    if (arrival === "unconfirmed") return finish("unverified", beforeFirstAnchoring(copy ?? through), {}, btc);
    return finish("departed-not-arrived", through, { destination }, btc);
  }
}

/**
 * P9.25: what `assembleAnchored` needs to resume from a checkpoint: the copy
 * through the checkpoint's head, which must hold its anchor and every entry
 * accepted after it, in order. Null when the copy cannot supply that.
 */
function resumeFrom(alias: string, cp: EvmCheckpoint, source: unknown[] | null): NonNullable<Parameters<typeof assembleAnchored>[5]["resume"]> | null {
  if (!source) return null;
  const at = source.findIndex((e) => (e as LogEntry | null)?.versionId === cp.head);
  if (at < 0) return null;
  const entries = source.slice(0, at + 1) as LogEntry[];
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
