/**
 * Anchored Originals: assembling the log from the anchoring sat (plan 012
 * §3.4; P9.10-P9.18; VH-Log PR 2, authoritative source).
 *
 * The caller supplies, for each sat it knows of, one read per Bitcoin index it
 * uses: the inscriptions that index reports, each with the sat number and
 * network the index places it on, its chain position, confirmation depth and
 * inscription time. Those are adapter assertions (P9.5); nothing here talks
 * to Bitcoin.
 *
 * - Placement rests on the index (P9.10): an inscription is on a did:btco
 *   alias's sat only when every index read for that alias reports it on that
 *   sat number on that network. The label a read is supplied under does not
 *   count. Indexes that disagree leave the inscription, and everything after
 *   it on that sat, undecided: missing evidence until they agree.
 * - Inscriptions carry complete entries as JSON Lines of
 *   `application/vnd.originals.vh+jsonl`, with no metadata, at most 350,000
 *   bytes (P9.17, D6 provisional). The anchoring inscription carries the whole
 *   log from genesis through the anchoring entry, its last entry; every later
 *   one carries exactly one entry. So every anchoring inscription checks
 *   itself, and a copy of the log is never needed: one that differs from the
 *   sat's entries is ignored.
 * - The anchor is the first valid anchoring inscription, in chain order,
 *   on the sat its anchoring entry names. Any other, on that sat or another,
 *   is a conflicting anchor (P9.16).
 * - Entries before the anchoring entry are checked against the signer DID
 *   version they name, with claimed ordering; the anchoring entry and every
 *   later one also against the signer's DID state at the inscription time
 *   (P9.15). After the anchor, an inscription is accepted when it extends the
 *   head at a strictly greater height (P9.13). Everything else is ignored and
 *   reported.
 * - An inscription counts from 1 confirmation, with its depth reported
 *   (P9.5, D6).
 */
import { OriginalsError } from "../errors.js";
import { isJsonObject } from "../json/index.js";
import { parseLog, type LogEntry, type LogVerification } from "../log/index.js";
import { authorKey, stillAuthorized, versionNumberOf, type AuthorHistory, type AuthorVersion } from "./author.js";
import { btcoAliasOf, parseBtcoAlias, type BitcoinNetwork, type BtcoAlias } from "./btco.js";
import { signerOf, type AuthorRef, type EntryState } from "./state.js";

/** PROVISIONAL (D6; P9.17): the media type of an Originals inscription. */
export const ORIGINALS_INSCRIPTION_TYPE = "application/vnd.originals.vh+jsonl";

/** PROVISIONAL (D6; P9.17): the largest inscription body, in bytes. */
export const ORIGINALS_INSCRIPTION_MAX_BYTES = 350_000;

/**
 * One inscription, as one index reports it. The same shape serves any sat:
 * an Original's anchoring sat, or a did:btco signer DID's sat (P5.13).
 */
export interface SatInscription {
  id: string;
  /** The sat number, in decimal, that the index reports the inscription on (P9.10). */
  sat: string;
  /** The network the index read it from (P9.10). */
  network: BitcoinNetwork;
  height: number;
  transactionIndex: number;
  inscriptionIndex: number;
  /** 0 while unconfirmed. */
  confirmations: number;
  /** The greatest block timestamp of its block and the block's ancestors, epoch ms (P9.15). */
  inscriptionTime: number;
  mediaType: string;
  content: Uint8Array;
  /** The inscription's raw metadata, or null or absent when it carries none. Originals inscriptions carry none (P9.17). */
  metadata?: Uint8Array | null;
}

/** What one index reported for one sat at one tip. */
export interface SatEvidence {
  /**
   * The did:btco alias whose sat this read was asked about. A label only:
   * each inscription counts for it by the sat and network the index reports
   * (P9.10).
   */
  sat: string;
  /** Which index served the read (P9.11). Reads of one sat by different indexes are compared. */
  index: string;
  tip: { height: number; hash: string };
  inscriptions: SatInscription[];
  /** The output holding the sat now, or null when the adapter observed none. */
  owner: { output: string; address?: string; confirmations: number } | null;
}

/** Why an inscription did not count for the sat it was read under. */
export type PlacementReason = "not-on-sat" | "other-network" | "placement-disputed" | "after-disputed-placement";

/** The inscriptions every index used places on one sat, merged (P9.10, P9.11). */
export interface SatRead {
  alias: BtcoAlias;
  /** The indexes whose reads were compared, in the order first supplied. */
  indexes: string[];
  /** The lowest tip among the reads. */
  tip: { height: number; hash: string };
  /**
   * Inscriptions every index places on the sat, in chain order, before the
   * first disputed one. Confirmations are the lowest any index reports.
   */
  inscriptions: SatInscription[];
  /** Inscriptions supplied under this alias that do not count for it. */
  excluded: Array<{ inscription: string; reason: PlacementReason }>;
  /** Inscriptions whose placement the indexes disagree on: missing evidence until they agree. */
  disputed: string[];
  /** The sat's holder when every index agrees on it; null when none was observed or they disagree. */
  owner: SatEvidence["owner"];
  ownerDisputed: boolean;
}

const sameBytes = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined) =>
  (a ?? null) === null ? (b ?? null) === null : !!b && a!.length === b.length && a!.every((x, k) => x === b[k]);

function sameReport(a: SatInscription, b: SatInscription): boolean {
  return a.height === b.height && a.transactionIndex === b.transactionIndex && a.inscriptionIndex === b.inscriptionIndex &&
    a.inscriptionTime === b.inscriptionTime && a.mediaType === b.mediaType && sameBytes(a.content, b.content) && sameBytes(a.metadata, b.metadata);
}

export function chainOrder(a: Pick<SatInscription, "height" | "transactionIndex" | "inscriptionIndex">, b: Pick<SatInscription, "height" | "transactionIndex" | "inscriptionIndex">): number {
  return a.height - b.height || a.transactionIndex - b.transactionIndex || a.inscriptionIndex - b.inscriptionIndex;
}

/**
 * Merge the reads of one sat by the indexes the verifier uses (P9.10). An
 * inscription counts only when every read reports it on the alias's sat
 * number and network, consistently; when they disagree, it and everything
 * after it in chain order on this sat are undecided. Unconfirmed
 * inscriptions are never disputed: they are only observed (P9.5).
 */
export function readSat(alias: string, reads: SatEvidence[]): SatRead {
  const parsed = parseBtcoAlias(alias);
  if (reads.length === 0) throw new OriginalsError("incomplete-evidence", "SAT_READ_MISSING", `no read of ${alias}`);
  const on = (i: SatInscription) => i.sat === parsed.sat && i.network === parsed.network;
  const ids = new Map<string, SatInscription[]>();
  for (const r of reads) for (const i of r.inscriptions) ids.set(i.id, [...(ids.get(i.id) ?? []), i]);

  const placed: SatInscription[] = [];
  const excluded: SatRead["excluded"] = [];
  const disputes: SatInscription[] = [];
  for (const [id, reports] of ids) {
    const placing = reports.filter(on);
    const everyIndex = placing.length === reads.length && reads.every((r) => r.inscriptions.some((i) => i.id === id && on(i)));
    if (everyIndex && placing.every((p) => sameReport(p, placing[0]))) {
      placed.push({ ...placing[0], confirmations: Math.min(...placing.map((p) => p.confirmations)) });
    } else if (placing.length === 0) {
      excluded.push({ inscription: id, reason: reports.some((i) => i.network !== parsed.network) ? "other-network" : "not-on-sat" });
    } else if (placing.every((p) => p.confirmations < 1)) {
      placed.push({ ...placing[0], confirmations: 0 }); // observed only
    } else {
      disputes.push(placing[0]);
    }
  }
  placed.sort(chainOrder);
  disputes.sort(chainOrder);
  const cut = disputes[0];
  const inscriptions = cut ? placed.filter((i) => chainOrder(i, cut) < 0) : placed;
  if (cut) {
    for (const d of disputes) excluded.push({ inscription: d.id, reason: "placement-disputed" });
    for (const i of placed) if (chainOrder(i, cut) >= 0) excluded.push({ inscription: i.id, reason: "after-disputed-placement" });
  }

  const owners = reads.map((r) => r.owner);
  const ownerDisputed = owners.some((o) => (o?.output ?? null) !== (owners[0]?.output ?? null) || (o?.address ?? null) !== (owners[0]?.address ?? null));
  const owner = !ownerDisputed && owners[0] ? { ...owners[0], confirmations: Math.min(...owners.map((o) => o!.confirmations)) } : null;
  const tip = reads.map((r) => r.tip).reduce((low, t) => (t.height < low.height ? t : low));
  return { alias: parsed, indexes: [...new Set(reads.map((r) => r.index))], tip, inscriptions, excluded, disputed: disputes.map((d) => d.id), owner, ownerDisputed };
}

export type IgnoredReason =
  | PlacementReason
  | "unconfirmed"
  | "not-an-originals-inscription"
  | "carries-metadata"
  | "too-large"
  | "undecodable"
  | "another-original"
  | "does-not-start-at-genesis"
  | "not-one-log"
  | "last-entry-not-anchoring"
  | "names-another-sat"
  | "more-than-one-entry"
  | "does-not-extend-head"
  | "not-above-previous-height"
  | "invalid-entry"
  | "author-version-unavailable"
  | "author-key-not-valid-at-inscription-time"
  | "author-deactivated-at-inscription-time";

export interface Placed {
  sat: string;
  inscription: string;
  versionId: string;
  height: number;
  confirmations: number;
  inscriptionTime: number;
}

/** The anchor a verifier reported, to retain between verifications (P9.16). */
export interface RetainedAnchor {
  inscription: string;
  sat: string;
  /** The sat's holder reported with it, as an output, or null. */
  owner: string | null;
}

export interface AnchoringReport {
  /** The anchoring sat: the anchor's, or the one the copy names. */
  sat: string;
  /**
   * anchored: an anchor was found on Bitcoin. unverified: Bitcoin evidence is
   * missing, or indexes disagree on placement before any anchor (P9.10).
   * not-anchored: the evidence supplied holds no valid anchor.
   */
  status: "anchored" | "unverified" | "not-anchored";
  anchor: Placed | null;
  /** Valid anchoring inscriptions other than the anchor; never current (P9.16). */
  conflicting: Placed[];
  /** Inscriptions accepted after the anchor, in chain order. */
  accepted: Placed[];
  ignored: Array<{ sat: string; inscription: string; versionId?: string; reason: IgnoredReason; code?: string }>;
  /** Inscriptions whose placement the indexes used disagree on: missing evidence until they agree (P9.10). */
  disputed: string[];
  /** The indexes whose reads of the anchoring sat were compared (P9.11). */
  indexes: string[];
  /**
   * The supplied copy of the log, against the sat's entries (P9.17): absent,
   * agrees (every entry Bitcoin also holds is the same), differs (ignored),
   * or used, when no anchor was found and the copy is what is verified.
   */
  copy: "absent" | "agrees" | "differs" | "used";
  /** Entries in the supplied copy that the sat's log does not include. */
  superseded: number;
  /** Set when the anchor differs from the retained one: the change, and the owner with it, is reported (P9.16). */
  change: { previous: RetainedAnchor; current: RetainedAnchor | null } | null;
  /** No index lists every sat (P9.16). */
  uniqueness: "not-established";
  tip: { height: number; hash: string } | null;
}

export interface OwnershipReport {
  /** Ownership is never established, only reported (P9.11, P9.16). */
  status: "provisional";
  sat: string;
  output: string;
  address?: string;
  confirmations: number;
  /** The indexes that agree on the holder (P9.11); more than one means independent agreement. */
  indexes: string[];
}

function stateOf(entry: unknown): Partial<EntryState> {
  const state = (entry as { state?: Partial<EntryState> } | null)?.state;
  return state ?? {};
}

function satNamedBy(entry: unknown): string | undefined {
  const aliases = stateOf(entry).asset?.aliases;
  return Array.isArray(aliases) ? btcoAliasOf(aliases) : undefined;
}

/** The index of the first entry that lists a did:btco alias: the anchoring entry (P9.10). */
export function anchoringIndex(entries: unknown[]): number {
  return entries.findIndex((e) => satNamedBy(e) !== undefined);
}

function decode(content: Uint8Array): LogEntry[] | undefined {
  try {
    const entries = parseLog(new TextDecoder("utf-8", { fatal: true }).decode(content));
    return entries.length > 0 && entries.every(isJsonObject) ? (entries as unknown as LogEntry[]) : undefined;
  } catch (error) {
    if (error instanceof OriginalsError || error instanceof TypeError) return undefined;
    throw error;
  }
}

/**
 * The reference of the DID that signs an entry (P5.14, P5.16): the editor's
 * for an editor entry, otherwise the author's, through `signerOf`.
 */
function signerRefOf(entry: unknown): AuthorRef | undefined {
  const state = stateOf(entry);
  return state.author ? signerOf(state as EntryState).ref : undefined;
}

/**
 * P9.15: the signer DID's state at an inscription is the later of the version
 * the entry names and the latest version whose versionTime is no later than
 * the inscription time. The key must hold in that state, which must not be
 * deactivated. (A did:btco signer DID is selected by chain order instead,
 * P5.13; that arrives with did:btco author DIDs.)
 */
export function checkAtInscriptionTime(entry: LogEntry, inscriptionTime: number, histories: AuthorHistory[]): IgnoredReason | null {
  const ref = signerRefOf(entry);
  const history = ref ? histories.find((h) => h.did === ref.did) : undefined;
  if (!ref || !history) return "author-version-unavailable";
  const named = history.versions.find((v) => v.versionId === ref.versionId);
  if (!named) return "author-version-unavailable";
  let before: AuthorVersion | undefined;
  for (const v of history.versions) if (v.time <= inscriptionTime) before = v;
  const state = before && before.versionNumber > named.versionNumber ? before : named;
  if (state.deactivated) return "author-deactivated-at-inscription-time";
  let key: string;
  try {
    key = authorKey(named, ref);
  } catch (error) {
    if (error instanceof OriginalsError) return "author-key-not-valid-at-inscription-time";
    throw error;
  }
  return stillAuthorized(state, ref, key) ? null : "author-key-not-valid-at-inscription-time";
}

export interface Assembly {
  /** The log to verify: the anchor's log and the accepted inscriptions, or the copy when there is no anchor. */
  entries: unknown[];
  report: AnchoringReport;
  owner: OwnershipReport | null;
  /** Reads whose holders the indexes disagree on (P9.11). */
  ownerDisputed: boolean;
  /** Ignored versionIds whose rejection came from the author checks, for retroactive-revocation reporting. */
  rejectedByAuthorState: Set<string>;
}

type Verify = (entries: unknown[]) => Promise<LogVerification>;

const passes = (v: LogVerification, length: number) => !v.failure && v.entries.length === length;
const CHAIN_CODES = new Set(["ENTRY_HASH_MISMATCH", "VERSION_NUMBER", "SCID_MISMATCH"]);

interface Anchoring {
  read: SatRead;
  inscription: SatInscription;
  entries: LogEntry[];
  original: string;
}

export interface AssembleOptions {
  /** The anchor reported before (P9.16): a different anchor now is reported as a change. */
  previousAnchor?: RetainedAnchor;
}

/**
 * Assemble an anchored Original's log from Bitcoin (plan 012 §3.4, P9.17).
 * `copy` is any copy of the log the caller holds, or null: it decides which
 * Original is meant, and is otherwise only compared with the sat's log.
 * Without a copy, the Original is the one the earliest valid anchoring
 * inscription supplied belongs to.
 */
export async function assembleFromBitcoin(
  copy: unknown[] | null,
  evidence: SatEvidence[],
  verify: Verify,
  histories: AuthorHistory[],
  options: AssembleOptions = {},
): Promise<Assembly> {
  const ignored: AnchoringReport["ignored"] = [];
  const rejectedByAuthorState = new Set<string>();
  const ignore = (sat: string, i: SatInscription | string, reason: IgnoredReason, entry?: LogEntry, code?: string) => {
    ignored.push({ sat, inscription: typeof i === "string" ? i : i.id, ...(entry?.versionId ? { versionId: entry.versionId } : {}), reason, ...(code ? { code } : {}) });
    if (entry && (reason === "author-key-not-valid-at-inscription-time" || reason === "author-deactivated-at-inscription-time")) rejectedByAuthorState.add(entry.versionId);
  };

  // One merged read per alias, from every index read supplied for it (P9.10).
  const byAlias = new Map<string, SatEvidence[]>();
  for (const e of evidence) {
    const did = parseBtcoAlias(e.sat).did;
    byAlias.set(did, [...(byAlias.get(did) ?? []), e]);
  }
  const reads = [...byAlias].map(([did, list]) => readSat(did, list));
  // The report lists what was ignored in chain order.
  const position = new Map<string, SatInscription>();
  for (const e of evidence) for (const i of e.inscriptions) if (!position.has(i.id)) position.set(i.id, i);
  const inChainOrder = () => ignored.sort((a, b) => chainOrder(position.get(a.inscription)!, position.get(b.inscription)!));
  for (const read of reads) for (const x of read.excluded) ignore(read.alias.did, x.inscription, x.reason);

  /** The inscription's entries when it is a usable Originals inscription, else why not. */
  const usable = (read: SatRead, i: SatInscription): LogEntry[] | undefined => {
    const sat = read.alias.did;
    if (i.confirmations < 1) return void ignore(sat, i, "unconfirmed");
    if (i.mediaType !== ORIGINALS_INSCRIPTION_TYPE) return void ignore(sat, i, "not-an-originals-inscription");
    if ((i.metadata ?? null) !== null) return void ignore(sat, i, "carries-metadata");
    if (i.content.length > ORIGINALS_INSCRIPTION_MAX_BYTES) return void ignore(sat, i, "too-large");
    const entries = decode(i.content);
    if (!entries) return void ignore(sat, i, "undecodable");
    return entries;
  };

  /** The anchoring inscription's verified log, or why it is not an anchor (P9.17). */
  const asAnchor = async (read: SatRead, i: SatInscription, entries: LogEntry[]): Promise<LogEntry[] | [IgnoredReason, string?]> => {
    if (versionNumberOf(entries[0]?.versionId) !== 1) return ["does-not-start-at-genesis"];
    if (anchoringIndex(entries) !== entries.length - 1) return ["last-entry-not-anchoring"];
    const last = entries[entries.length - 1];
    if (satNamedBy(last) !== read.alias.did) return ["names-another-sat"];
    const v = await verify(entries);
    if (!passes(v, entries.length)) {
      const code = v.failure?.error.code;
      return [code && CHAIN_CODES.has(code) ? "not-one-log" : "invalid-entry", code];
    }
    const author = checkAtInscriptionTime(last, i.inscriptionTime, histories);
    return author ? [author] : entries;
  };

  const originalOf = (entries: unknown[]) => stateOf(entries[0]).id;
  let target = copy && copy.length > 0 ? originalOf(copy) : undefined;

  // Classify every usable inscription on every sat. Multi-entry inscriptions are
  // anchoring candidates; single entries only matter after an anchor.
  const anchorings: Anchoring[] = [];
  const singles = new Map<SatRead, Array<{ inscription: SatInscription; entry: LogEntry }>>();
  const rejected: Array<{ read: SatRead; inscription: SatInscription; entries: LogEntry[]; reason: IgnoredReason; code?: string }> = [];
  for (const read of reads) {
    const list: Array<{ inscription: SatInscription; entry: LogEntry }> = [];
    singles.set(read, list);
    for (const i of read.inscriptions) {
      const entries = usable(read, i);
      if (!entries) continue;
      const result = await asAnchor(read, i, entries);
      if (!Array.isArray(result) || typeof result[0] !== "string") {
        const log = result as LogEntry[];
        anchorings.push({ read, inscription: i, entries: log, original: originalOf(log) as string });
      } else {
        const [reason, code] = result as [IgnoredReason, string?];
        if (entries.length === 1) list.push({ inscription: i, entry: entries[0] });
        rejected.push({ read, inscription: i, entries, reason, ...(code ? { code } : {}) });
      }
    }
  }
  anchorings.sort((a, b) => chainOrder(a.inscription, b.inscription));
  target ??= anchorings[0]?.original;
  const mine = anchorings.filter((a) => a.original === target);
  for (const a of anchorings) if (a.original !== target) ignore(a.read.alias.did, a.inscription, "another-original", a.entries[a.entries.length - 1]);
  const chosen = mine[0];

  const place = (sat: string, i: SatInscription, entry: LogEntry): Placed => ({
    sat, inscription: i.id, versionId: entry.versionId, height: i.height, confirmations: i.confirmations, inscriptionTime: i.inscriptionTime,
  });
  const lastOf = (a: Anchoring) => a.entries[a.entries.length - 1];
  const disputed = reads.flatMap((r) => r.disputed);
  const named = copy ? (() => {
    const k = anchoringIndex(copy);
    return k >= 0 ? satNamedBy(copy[k]) : undefined;
  })() : undefined;

  if (!chosen) {
    for (const r of rejected) ignore(r.read.alias.did, r.inscription, r.reason, r.entries[r.entries.length - 1], r.code);
    const status = evidence.length === 0 || disputed.length > 0 ? "unverified" : "not-anchored";
    const copyAnchor = copy ? anchoringIndex(copy) : -1;
    const entries = !copy ? [] : status === "unverified" || copyAnchor < 0 ? copy : copy.slice(0, copyAnchor);
    const change = status === "not-anchored" && options.previousAnchor ? { previous: options.previousAnchor, current: null } : null;
    inChainOrder();
    return {
      entries,
      report: {
        sat: named ?? reads[0]?.alias.did ?? "", status, anchor: null, conflicting: [], accepted: [], ignored, disputed,
        indexes: reads[0]?.indexes ?? [], copy: copy ? "used" : "absent", superseded: 0, change, uniqueness: "not-established", tip: reads[0]?.tip ?? null,
      },
      owner: null,
      ownerDisputed: false,
      rejectedByAuthorState,
    };
  }

  const read = chosen.read;
  const sat = read.alias.did;
  const anchor = place(sat, chosen.inscription, lastOf(chosen));
  const conflicting = mine.slice(1).map((a) => place(a.read.alias.did, a.inscription, lastOf(a)));
  // Inscriptions that are neither anchors nor, on the anchoring sat after the anchor, single entries.
  for (const r of rejected) {
    const after = r.read === read && chainOrder(r.inscription, chosen.inscription) > 0;
    if (after && r.entries.length > 1) ignore(sat, r.inscription, "more-than-one-entry", r.entries[r.entries.length - 1]);
    else if (!after) ignore(r.read.alias.did, r.inscription, r.reason, r.entries[r.entries.length - 1], r.code);
  }

  // After the anchor: one entry per inscription, extending the head at a greater height (P9.13).
  const head: LogEntry[] = [...chosen.entries];
  const accepted: Placed[] = [];
  let lastHeight = chosen.inscription.height;
  for (const { inscription: i, entry } of singles.get(read)!) {
    if (chainOrder(i, chosen.inscription) <= 0) continue;
    if (i.height <= lastHeight) {
      ignore(sat, i, "not-above-previous-height", entry);
      continue;
    }
    const n = versionNumberOf(entry.versionId);
    const candidate = [...head, entry];
    const v = n === head.length + 1 ? await verify(candidate) : null;
    if (!v || !passes(v, candidate.length)) {
      ignore(sat, i, !v || v.failure?.error.code === "ENTRY_HASH_MISMATCH" ? "does-not-extend-head" : "invalid-entry", entry, v?.failure?.error.code);
      continue;
    }
    const author = checkAtInscriptionTime(entry, i.inscriptionTime, histories);
    if (author) {
      ignore(sat, i, author, entry);
      continue;
    }
    head.push(entry);
    accepted.push(place(sat, i, entry));
    lastHeight = i.height;
  }

  // A copy is compared, never used (P9.17).
  let copyStatus: AnchoringReport["copy"] = "absent";
  let superseded = 0;
  if (copy) {
    const differs = copy.length === 0 || copy.some((e, k) => k < head.length && (e as LogEntry | null)?.versionId !== head[k].versionId);
    copyStatus = differs ? "differs" : "agrees";
    const included = new Set(head.map((e) => e.versionId));
    superseded = copy.filter((e) => !included.has((e as LogEntry | null)?.versionId as string)).length;
  }

  inChainOrder();
  const owner = read.owner;
  const current: RetainedAnchor = { inscription: anchor.inscription, sat, owner: owner?.output ?? null };
  const previous = options.previousAnchor;
  const change = previous && (previous.inscription !== current.inscription || previous.sat !== current.sat) ? { previous, current } : null;
  return {
    entries: head,
    report: {
      sat, status: "anchored", anchor, conflicting, accepted, ignored, disputed, indexes: read.indexes, copy: copyStatus, superseded, change,
      uniqueness: "not-established", tip: read.tip,
    },
    owner: owner
      ? { status: "provisional", sat, output: owner.output, ...(owner.address ? { address: owner.address } : {}), confirmations: owner.confirmations, indexes: read.indexes }
      : null,
    ownerDisputed: read.ownerDisputed,
    rejectedByAuthorState,
  };
}
