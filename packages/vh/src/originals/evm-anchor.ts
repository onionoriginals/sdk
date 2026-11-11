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
  type RetainedAnchor,
} from "./bitcoin.js";
import type { SatEvidence, SatInscription } from "./btco.js";
import {
  caip19Of,
  checkAnchor,
  classAt,
  currentClass,
  describeClass,
  evmSupport,
  layerOfClass,
  type EvmAnchor,
  type EvmAnchorPin,
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
   * P9.24 (MAY): uniqueness established under this chain's finality, its
   * class and the providers used, never more; on an attested chain it is
   * described as attested, never as proven (P9.27).
   */
  uniqueness: { status: "established-under-chain"; describes: ReturnType<typeof describeClass>; block: { number: number; hash: string }; providers: string[] } | { status: "not-established" };
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
  /** For departed-not-arrived: where the move entry goes (P9.29). */
  destination: string | null;
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
  | { kind: "read"; read: AnchorRead; inscriptions: SatInscription[]; preIgnored: EvmStretch["ignored"]; block: { number: number; hash: string }; providers: string[]; holder: string | null; observed: EvmStretch["observed"]; times: Map<number, { timestamp: number; time: number }>; finality: EvmStretch["finality"]; records: EvmRecord[] }
  | { kind: "missing"; code: string; message: string; block: { number: number; hash: string } | null; providers: string[] }
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
  excluded: EvmStretch["excludedProviders"],
): TokenRead {
  const missing = (code: string, message: string, block: { number: number; hash: string } | null = null, providers: string[] = []): TokenRead => ({ kind: "missing", code, message, block, providers });
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
  // P9.22: the lower of the providers' finalized blocks, read from every provider.
  const common = Math.min(...reads.map((r) => r.finalized));
  if (reads.some((r) => r.block.number !== common)) {
    return missing("EVM_READ_NOT_AT_FINALIZED", `every provider must be read at block ${common}, the lower of their finalized blocks (P9.22)`, null, providers);
  }
  const block = { number: common, hash: reads[0].block.hash.toLowerCase() };
  if (reads.some((r) => r.block.hash.toLowerCase() !== block.hash)) {
    return missing("EVM_PROVIDERS_DISAGREE", `providers report different hashes for block ${common} (P9.22)`, null, providers);
  }
  const codes = new Set(reads.map((r) => lower(r.codeHash)));
  if (codes.size > 1) return missing("EVM_PROVIDERS_DISAGREE", `providers report different code at the anchor contract address at block ${common} (P9.22)`, block, providers);
  const code = reads[0].codeHash?.toLowerCase() ?? null;
  // P9.21: other code, or none, at the pinned address is not an Originals anchor: unsupported.
  if (code !== pin.codeHash.toLowerCase()) {
    return { kind: "unsupported", code: "EVM_ANCHOR_CODE_MISMATCH", message: `the code at ${pin.address} on ${listed.chain} at block ${common} ${code === null ? "is absent" : `has hash ${code}`}, not the pinned ${pin.codeHash}: unsupported, never not anchored (P9.21)` };
  }
  if (new Set(reads.map((r) => lower(r.owner))).size > 1) return missing("EVM_PROVIDERS_DISAGREE", `providers report different ownerOf for ${alias} at block ${common} (P9.22)`, block, providers);
  const lists = reads.map((r) => r.records);
  if (lists.some((l) => l === null)) return missing("EVM_RECORDS_UNREADABLE", `the records of ${alias} could not be read from state at block ${common} (P9.25)`, block, providers);
  const records = lists[0]!;
  if (lists.some((l) => l!.length !== records.length || l!.some((r, k) => !sameRecord(r, records[k])))) {
    return missing("EVM_PROVIDERS_DISAGREE", `providers report different records or bytes for ${alias} at block ${common} (P9.22)`, block, providers);
  }
  if (records.some((r, k) => r.index !== k)) return missing("EVM_RECORDS_UNREADABLE", `the records of ${alias} are not every index from 0 in order (P14.20)`, block, providers);

  // P9.22: a retained finalized block that the chain has replaced is a finality failure.
  let finality: EvmStretch["finality"] = "unchecked";
  for (const r of retained.filter((x) => x.chain === listed.chain)) {
    const seen = r.number === block.number ? block.hash : reads.flatMap((x) => x.blockHashes ?? []).find((h) => h.number === r.number)?.hash.toLowerCase();
    if (seen === undefined) continue;
    if (seen !== r.hash.toLowerCase()) finality = "failed";
    else if (finality !== "failed") finality = "held";
  }

  // P9.20, P9.25, P14.20: records as inscriptions, height = index; inscription time the greatest timestamp so far.
  const inscriptions: SatInscription[] = [];
  const preIgnored: EvmStretch["ignored"] = [];
  const times = new Map<number, { timestamp: number; time: number }>();
  let latest = 0;
  for (const rec of records) {
    latest = Math.max(latest, rec.timestamp);
    times.set(rec.index, { timestamp: rec.timestamp, time: latest * 1000 });
    // Decided from the record's own fields, without reading its bytes; never missing evidence (P9.25).
    if (utf8Length(rec.mediaType) > MEDIA_TYPE_MAX_BYTES) {
      preIgnored.push({ index: rec.index, reason: "media-type-too-long" });
      continue;
    }
    const stored = rec.bodyOf === rec.index;
    if ((stored ? rec.metadataLength + rec.bodyLength : rec.metadataLength) > ORIGINALS_INSCRIPTION_MAX_BYTES) {
      preIgnored.push({ index: rec.index, reason: "too-large" });
      continue;
    }
    const referred = stored ? rec : records[rec.bodyOf];
    // The contract allows only an earlier record of the token that stored its own body (P14.20).
    if (!referred || rec.bodyOf > rec.index || referred.bodyOf !== referred.index) {
      preIgnored.push({ index: rec.index, reason: "invalid-body-reference" });
      continue;
    }
    const body = rec.body ?? (stored ? undefined : referred.body);
    if (rec.metadata === undefined || body === undefined) {
      return missing("EVM_RECORD_BYTES_UNREAD", `the bytes of record ${rec.index} of ${alias} were not read from state (P9.25)`, block, providers);
    }
    // PROVISIONAL: a referring record's `bodyLength` is read as the referred body's length.
    if (rec.metadata.length !== rec.metadataLength || body.length !== referred.bodyLength) {
      return missing("EVM_RECORD_BYTES_UNREAD", `the bytes read for record ${rec.index} of ${alias} are not the lengths it records (P14.20)`, block, providers);
    }
    inscriptions.push({
      id: `${alias}#${rec.index}`, sat: alias, network: "mainnet", height: rec.index, transactionIndex: 0, inscriptionIndex: 0,
      confirmations: 1, inscriptionTime: latest * 1000, mediaType: rec.mediaType, content: body, metadata: rec.metadata,
    });
  }
  const observed = [...new Map(reads.flatMap((r) => r.observed ?? []).filter((o) => o.index >= records.length).map((o) => [o.index, { index: o.index, timestamp: o.timestamp }])).values()]
    .sort((a, b) => a.index - b.index);
  const holder = lower(reads[0].owner);
  const read: AnchorRead = { alias: { did: alias }, indexes: providers, tip: { height: block.number, hash: block.hash }, inscriptions, excluded: [], disputed: [], owner: null, ownerDisputed: false };
  return { kind: "read", read, inscriptions, preIgnored, block, providers, holder, observed, times, finality, records };
}

const indexOf = (id: string) => Number(id.slice(id.lastIndexOf("#") + 1));

function unsupportedReport(code: string, message: string, chain: string, stretches: EvmStretch[] = []): EvmAnchoringReport {
  return { status: "unsupported", move: "none", stretches, owner: null, destination: null, unsupported: { code, message, chain }, warnings: [] };
}

/** The entries before the first anchoring entry of `copy`, or all of it when it has none (P7.14). */
function beforeFirstAnchoring(copy: unknown[] | null): unknown[] {
  if (!copy) return [];
  const k = copy.findIndex((e) => tokenNamedBy(e) !== undefined || (assetOf(e)?.aliases ?? []).some((a) => typeof a === "string" && a.startsWith("did:btco:")));
  return k < 0 ? copy : copy.slice(0, k);
}

/** The genesis entry: the copy's, or the first entry any supplied token's records carry. PROVISIONAL. */
function genesisOf(copy: unknown[] | null, tokens: EvmTokenEvidence[]): unknown {
  if (copy && copy.length > 0) return copy[0];
  for (const t of tokens) {
    for (const r of t.reads) {
      for (const rec of r.records ?? []) {
        const carried = readInscribedEntries(rec.metadata);
        if (carried.kind === "entries") return carried.entries[0];
      }
    }
  }
  return undefined;
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
  const genesis = genesisOf(copy, evidence.tokens);
  const genesisAnchor = assetOf(genesis)?.anchor;
  if (genesisAnchor === undefined) return null;
  const did = (genesis as { state?: { id?: unknown } }).state?.id;
  const empty = (report: EvmAnchoringReport, entries: unknown[] = []): EvmAssembly => ({ entries, report, bitcoin: null, bytes: new Map(), rejectedByAuthorState: new Set(), retainedBlocks: [] });
  let anchor = anchorOf(genesis);
  if (!anchor || typeof did !== "string") {
    // A malformed anchor member is the log's failure (P14.18); verify the copy and let it report it.
    return empty({ status: "unverified", move: "none", stretches: [], owner: null, destination: null, unsupported: null, warnings: [] }, copy ?? []);
  }
  const pin = evidence.pin;

  const stretches: EvmStretch[] = [];
  const bytes = new Map<string, { bytes: Uint8Array; chain: string }>();
  const rejectedByAuthorState = new Set<string>();
  const retainedBlocks: RetainedEvmBlock[] = [];
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
    return {
      entries,
      report: { status, move, stretches, owner, destination: null, unsupported: null, warnings, ...extra },
      bitcoin: btc,
      bytes,
      rejectedByAuthorState,
      ...(retainedAnchor ? { retainedAnchor } : {}),
      retainedBlocks,
    };
  };

  for (;;) {
    // P9.19, P9.21, section 14: no pin, or an unlisted chain, is unsupported, never invalid.
    const support = evmSupport(anchor.chain, pin);
    if (!support.supported) {
      const code = support.reason === "chain-not-listed" ? "EVM_CHAIN_NOT_LISTED" : "EVM_NO_ANCHOR_CONTRACT";
      const message = support.reason === "chain-not-listed"
        ? `${anchor.chain} is not in this verifier's revision of P14.22: unsupported, not invalid (P9.19)`
        : "P14.21 pins no anchor contract: an Original with an anchor member is unsupported, not invalid (section 14)";
      return { ...empty(unsupportedReport(code, message, anchor.chain, stretches)) };
    }
    const { listed } = support;
    const alias = derivedTokenAlias(did, anchor, support.pin);
    const cls = currentClass(listed);
    const excluded: EvmStretch["excludedProviders"] = [];
    const supplied = evidence.tokens.filter((t) => t.alias === alias);
    const token = readToken(alias, listed, support.pin, supplied, evidence.retained ?? [], excluded);
    if (token.kind === "unsupported") return empty(unsupportedReport(token.code, token.message, anchor.chain, stretches));
    const stretch: EvmStretch = {
      chain: listed.chain, name: listed.name, class: cls, layer: layerOfClass(cls), describes: describeClass(cls), token: alias, caip19: caip19Of(alias),
      status: "unverified", arrival: arrival !== undefined, anchor: null, conflicting: [], accepted: [], entries: [], carried: [], departure: null,
      ignored: [], unverifiable: [], observed: [], block: token.block, providers: token.providers, excludedProviders: excluded, holder: null,
      finality: "unchecked", uniqueness: { status: "not-established" }, change: null, headChange: null,
    };
    stretches.push(stretch);

    if (token.kind === "missing") {
      stretch.missing = { code: token.code, message: token.message };
      // P9.29: a chain the Original left that cannot be read leaves the move unconfirmed, and the
      // log the arrival carries is still verified. Which move left it is known only from the copy.
      const k = copy ? copy.findIndex((e, j) => j > 0 && tokenNamedBy(copy[j - 1]) === alias && departsFrom(e as LogEntry, copy[j - 1] as LogEntry)) : -1;
      const next = k >= 0 ? anchorOf(copy![k]) : undefined;
      const btcoNext = k >= 0 && next === undefined;
      const destinationSupplied = next ? evidence.tokens.some((t) => t.chain === next.chain) : btcoNext && bitcoin.length > 0;
      if (k >= 0 && destinationSupplied) {
        move = "unconfirmed";
        arrival = "unconfirmed";
        if (next) {
          anchor = next;
          continue;
        }
        return toBitcoin(copy!.slice(0, k + 1) as LogEntry[]);
      }
      // P7.14: without every chain in the path, at most the entries before the first anchoring entry.
      return finish("unverified", beforeFirstAnchoring(copy ?? throughDeparture));
    }

    // P9.28: a move's layers are judged at its departure record's timestamp; record it before verifying.
    for (const i of token.inscriptions) {
      const carried = readInscribedEntries(i.metadata);
      if (carried.kind === "entries" && carried.entries.length === 1 && typeof carried.entries[0].versionId === "string" && !options.moveTimes.has(carried.entries[0].versionId)) {
        options.moveTimes.set(carried.entries[0].versionId, token.times.get(i.height)!.timestamp * 1000);
      }
    }
    const previousAnchor = options.previousAnchor?.sat === alias ? options.previousAnchor : undefined;
    const core = await assembleAnchored(copy ?? (Array.isArray(arrival) ? arrival : null), [token.read], token.inscriptions, verify, histories, {
      ...(previousAnchor ? { previousAnchor } : {}),
      ...(previousAnchor && options.previousHead !== undefined ? { previousHead: options.previousHead } : {}),
      ...(arrival ? { arrival } : {}),
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
    if (token.finality === "failed") {
      if (!warnings.includes("authoritative-source-changed")) warnings.push("authoritative-source-changed");
    }

    // P9.28: a move entry to an unlisted chain is unsupported, not invalid; it is not a departure.
    const unlisted = stretch.ignored.find((x) => x.code === "EVM_CHAIN_NOT_LISTED");
    if (unlisted) {
      stretch.status = core.report.status === "anchored" ? "anchored" : "not-anchored";
      return empty(unsupportedReport("EVM_CHAIN_NOT_LISTED", `the move entry ${unlisted.versionId ?? ""} names a destination this verifier's revision of P14.22 does not list: unsupported, not invalid (P9.19, P9.28)`, anchor.chain, stretches), core.entries);
    }

    if (core.report.status !== "anchored") {
      stretch.status = "not-anchored";
      if (arrival !== undefined) {
        // P9.29: departed, not arrived, with the move entry's state and no owner. Unconfirmed
        // when the chain left was not read: the log is then what the copy shows through the move.
        if (arrival === "unconfirmed") return finish("unverified", beforeFirstAnchoring(copy));
        return finish("departed-not-arrived", throughDeparture!, { destination: alias });
      }
      // P9.23: minted or not, no valid anchoring publication: not anchored, no owner.
      return finish("not-anchored", core.entries);
    }

    stretch.status = "anchored";
    const anchorPlaced = placedOf(core.report.anchor!);
    stretch.anchor = anchorPlaced;
    stretch.conflicting = core.report.conflicting.map(placedOf);
    stretch.accepted = core.report.accepted.map(placedOf);
    const head = core.entries as LogEntry[];
    const anchorAt = head.findIndex((e) => e.versionId === anchorPlaced.versionId);
    stretch.carried = head.slice(0, arrival !== undefined ? anchorAt + 1 : anchorAt).map((e) => e.versionId);
    stretch.entries = [...(arrival !== undefined ? [] : [anchorPlaced.versionId]), ...stretch.accepted.map((a) => a.versionId)];
    // P9.24 (MAY): uniqueness established only under this chain's finality, class and providers.
    stretch.uniqueness = { status: "established-under-chain", describes: stretch.describes, block: token.block, providers: token.providers };
    for (const [digest, b] of core.bytes) bytes.set(digest, { bytes: b, chain: listed.chain });
    retainedAnchor = { inscription: core.report.anchor!.inscription, sat: alias, owner: token.holder };
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
    if (btc.report.status === "unverified") return finish("unverified", beforeFirstAnchoring(copy ?? through), {}, btc);
    if (arrival === "unconfirmed") return finish("unverified", beforeFirstAnchoring(copy ?? through), {}, btc);
    return finish("departed-not-arrived", through, { destination }, btc);
  }
}
