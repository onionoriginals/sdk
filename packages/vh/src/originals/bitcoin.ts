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
 *   it on that sat, undecided: missing evidence until they agree. A disputed
 *   inscription that no index reports as an Originals inscription cannot be
 *   an entry: it is ignored and holds back nothing after it (`couldCount`).
 * - Inscriptions carry complete entries as JSON Lines of
 *   `application/vnd.originals.vh+jsonl`, with no metadata, at most 350,000
 *   bytes (P9.17, P14.12; owner decision, D6; originals-spec #50, merged). The anchoring inscription carries the whole
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
 *   (P9.15). For a did:btco signer DID that state is the latest version
 *   before the inscription in chain order, and a named version must precede
 *   the inscription carrying the entry, or the anchoring inscription for an
 *   entry before it (P5.13). The signer is the editor DID for an editor
 *   entry, which is also refused when the author DID's state at its
 *   inscription time is deactivated (P5.18). Only an author entry anchors
 *   (P5.16). After the anchor, an inscription is accepted when it extends the
 *   head at a strictly greater height (P9.13), so chain order decides between
 *   an editor entry and a revocation of its grant with the same parent
 *   (P5.17). Everything else is ignored and reported.
 * - An inscription counts from 1 confirmation on every network, mainnet
 *   included, with its depth reported (P9.5, D6; owner decision, originals-spec
 *   #50, merged). There is no per-network confirmation policy.
 */
import { OriginalsError } from "../errors.js";
import { isJsonObject } from "../json/index.js";
import { exactNumberError } from "./profile.js";
import { compactLineError, parseLog, type LogEntry, type LogVerification } from "../log/index.js";
import { authorKey, stillAuthorized, versionNumberOf, type AuthorHistory, type AuthorVersion } from "./author.js";
import { btcoAliasOf, chainOrder, parseBtcoAlias, readSat, type ChainPosition, type PlacementReason, type SatEvidence, type SatInscription, type SatRead } from "./btco.js";
import { ORIGINALS_LIMITS, signerOf, type AuthorRef, type EntryState } from "./state.js";

/** The media type of an Originals inscription (P9.17, P14.12; owner decision, D6; originals-spec #50, merged). */
export const ORIGINALS_INSCRIPTION_TYPE = "application/vnd.originals.vh+jsonl";

/** The largest inscription body, in bytes (P9.17, P14.12; owner decision, D6; originals-spec #50, merged). */
export const ORIGINALS_INSCRIPTION_MAX_BYTES = 350_000;

export type IgnoredReason =
  | PlacementReason
  | "unconfirmed"
  | "not-an-originals-inscription"
  /** An Originals media type whose own body is delegated or encoded (P9.14, P9.17). */
  | "unsupported-encoding"
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
  /**
   * After the anchor: an inscription whose signer DID version this verifier
   * has no verified copy of, numbered past the newest it holds (or of a DID
   * it holds no history for, or of a did:btco whose sat was not read in full
   * through the inscription). It is reported in `unverifiable` and holds
   * nothing back (P9.12, P9.15; owner decision, 23 Oct 2026;
   * originals-spec #51, merged).
   */
  | "later-inscription-unverifiable"
  /**
   * After the anchor: a publication extending the head while an earlier
   * inscription extending the same head is unverifiable. Chain order decides,
   * so it is not accepted until that one is resolved; `waitingOn` names it
   * (P9.15; originals-spec #51, merged).
   */
  | "waiting-for-earlier-unverifiable"
  | "author-version-not-yet-in-effect"
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
  /**
   * The inscriptions after the anchor reported unverifiable with it, when any
   * were: one later verified and accepted is reported as a change of head
   * (`AnchoringReport.headChange`, P9.15).
   */
  unverifiable?: string[];
  /** The inscriptions after the anchor accepted with it: one unverifiable later is a change of head, not a new one (P9.15). */
  accepted?: string[];
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
  ignored: Array<{ sat: string; inscription: string; versionId?: string; reason: IgnoredReason; code?: string; waitingOn?: string }>;
  /**
   * Inscriptions after the anchor whose signer DID version could not be
   * verified (`later-inscription-unverifiable`), with the signer DID and the
   * version they name. The holder of the sat decides what is inscribed but
   * has no authority (P9.12), so these never change the accepted head or its
   * identity evidence; a verifier that obtains the named version can verify
   * them, and reports the change of head when it does (`headChange`; P9.15,
   * P5.6; owner decision, 23 Oct 2026; originals-spec #51, merged).
   */
  unverifiable: Array<{ sat: string; inscription: string; versionId?: string; signer: string; signerVersionId: string }>;
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
  /**
   * Set when the head moves from the one retained before because an
   * inscription's verifiability changed, never silently (P9.15, as P9.16 for
   * an anchor; originals-spec #51, merged): `resolved`, the inscriptions
   * reported unverifiable before (the retained anchor's `unverifiable`) that
   * no longer are, accepted or rejected; `verified`, the inscriptions accepted
   * past the retained head; `unverified`, inscriptions accepted before that
   * are unverifiable now; `vanished`, those reported unverifiable before that
   * the sat no longer carries, as after a reorganization (P9.5).
   */
  headChange: { previous: string | null; current: string; verified: Placed[]; resolved: string[]; unverified: string[]; vanished: string[] } | null;
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

/** The body's entries: compact JSON Lines, each line ending in one LF (P14.2), or undefined. */
function decode(content: Uint8Array): LogEntry[] | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
    if (!text.endsWith("\n") || text.slice(0, -1).split("\n").some((line) => compactLineError(line) !== undefined || exactNumberError(line) !== undefined)) return undefined;
    const entries = parseLog(text);
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
 * A DID's state at an inscription (P9.15, P5.13): for did:btco, the latest
 * version preceding the inscription in chain order, established through it
 * (not past the tip read, nor past an inscription the indexes dispute); for
 * did:vh and did:webvh, the later of the named version, when there is one,
 * and the latest version whose versionTime is no later than the inscription
 * time.
 */
function stateAt(history: AuthorHistory, named: AuthorVersion | undefined, inscription: SatInscription): AuthorVersion | IgnoredReason {
  let state: AuthorVersion | undefined;
  if (history.method === "did:btco") {
    if (history.establishedBefore && chainOrder(inscription, history.establishedBefore) >= 0) return "author-version-unavailable";
    for (const v of history.versions) if (v.position && chainOrder(v.position, inscription) < 0) state = v;
  } else {
    for (const v of history.versions) if (v.time <= inscription.inscriptionTime) state = v;
    if (named && (!state || named.versionNumber > state.versionNumber)) state = named;
  }
  return state ?? "author-version-unavailable";
}

/**
 * The signer DID's state at an inscription, and whether the entry's key holds
 * there. The key must meet P5.3 at the version the entry names and in that
 * state, which must not be deactivated.
 *
 * - did:btco (P5.13): the named version must precede the inscription in
 *   chain order, so a version mined later, even later in the same block, is
 *   not yet in effect: its id can be known before it is mined. The state is
 *   the latest version preceding the inscription. The history must be
 *   established through the inscription: not past the tip read, nor past an
 *   inscription the indexes dispute.
 * - did:vh and did:webvh (P9.15): the state is the later of the named version
 *   and the latest version whose versionTime is no later than the inscription
 *   time, so a named later version can list a removed key again (C12-98,
 *   C12-44).
 *
 * The signer is the entry's, through `signerOf`: the editor DID for an editor
 * entry, so these rules apply to editor DIDs as they do to the author DID
 * (P5.18), and the `author-*` reasons name the signer DID's state. An editor
 * entry is also refused when the author DID's state at the inscription is
 * deactivated (P5.18, P9.15): `author-deactivated-at-inscription-time`.
 */
export function checkAtInscriptionTime(entry: LogEntry, inscription: SatInscription, histories: AuthorHistory[]): IgnoredReason | null {
  const found = signerVersion(entry, histories);
  if (typeof found === "string") return found;
  const { ref, history, named } = found;
  if (history.method === "did:btco") {
    if (!named.position) return "author-version-unavailable";
    if (chainOrder(named.position, inscription) >= 0) return "author-version-not-yet-in-effect";
  }
  const state = stateAt(history, named, inscription);
  if (typeof state === "string") return state;
  if (state.deactivated) return "author-deactivated-at-inscription-time";
  const editorEntry = stateOf(entry);
  if (editorEntry.editor && editorEntry.author) {
    const author = editorEntry.author;
    const authorHistory = histories.find((h) => h.did === author.did);
    if (!authorHistory) return "author-version-unavailable";
    const authorState = stateAt(authorHistory, authorHistory.versions.find((v) => v.versionId === author.versionId), inscription);
    if (typeof authorState === "string") return authorState;
    if (authorState.deactivated) return "author-deactivated-at-inscription-time";
  }
  let key: string;
  try {
    key = authorKey(named, ref);
  } catch (error) {
    if (error instanceof OriginalsError) return "author-key-not-valid-at-inscription-time";
    throw error;
  }
  return stillAuthorized(state, ref, key) ? null : "author-key-not-valid-at-inscription-time";
}

/**
 * An entry before the anchoring entry has claimed ordering and is checked
 * against the version it names (P9.15); that check is the log's. But a
 * did:btco version must precede the anchoring inscription that carries the
 * entry, so one mined at or after it is not yet in effect (P5.13).
 */
export function checkBeforeAnchor(entry: LogEntry, anchoring: SatInscription, histories: AuthorHistory[]): IgnoredReason | null {
  const found = signerVersion(entry, histories);
  if (typeof found === "string") return found;
  const { history, named } = found;
  if (history.method !== "did:btco") return null;
  if (!named.position) return "author-version-unavailable";
  return chainOrder(named.position, anchoring) >= 0 ? "author-version-not-yet-in-effect" : null;
}

function signerVersion(entry: LogEntry, histories: AuthorHistory[]): { ref: AuthorRef; history: AuthorHistory; named: AuthorVersion } | IgnoredReason {
  const ref = signerRefOf(entry);
  const history = ref ? histories.find((h) => h.did === ref.did) : undefined;
  if (!ref || !history) return "author-version-unavailable";
  const named = history.versions.find((v) => v.versionId === ref.versionId);
  return named ? { ref, history, named } : "author-version-unavailable";
}

/**
 * Whether a did:btco history is established through an inscription (P5.13,
 * P9.15): its sat was read in full past it, or the DID is deactivated, which
 * settles every later position. A version preceding the inscription is then
 * one of `versions`.
 */
function btcoReadThrough(history: AuthorHistory, inscription: SatInscription): boolean {
  if (history.versions[history.versions.length - 1]?.deactivated) return true;
  return history.establishedBefore !== undefined && chainOrder(inscription, history.establishedBefore) < 0;
}

/**
 * P9.12, P9.15, P5.13 (owner decision, 23 Oct 2026; originals-spec #51, merged):
 * why an inscription after
 * the anchor whose signer could not be verified is ignored. A named version
 * the signer's history shows is not that DID's makes the entry invalid
 * (AUTHOR_VERSION_NOT_IN_HISTORY): for a did:vh or did:webvh, one numbered at
 * or below the newest verified version but not in the history; for a
 * did:btco whose sat was read in full through the inscription, any versionId
 * not among its versions. Anything else (a later version, a DID with no
 * history here, a did:btco sat not read in full through the inscription) is
 * unverifiable, not incomplete identity evidence for the accepted head: the
 * sat's holder chooses what is inscribed and has no authority over the
 * Original.
 */
function unverifiedLater(entry: LogEntry, inscription: SatInscription, histories: AuthorHistory[]): { reason: IgnoredReason; code?: string; ref?: AuthorRef } {
  if (impossibleVersion(entry, histories)) return { reason: "invalid-entry", code: "AUTHOR_VERSION_IMPOSSIBLE" };
  if (notInHistory(entry, inscription, histories)) return { reason: "invalid-entry", code: "AUTHOR_VERSION_NOT_IN_HISTORY" };
  const ref = signerRefOf(entry);
  return { reason: "later-inscription-unverifiable", ...(ref ? { ref } : {}) };
}

/**
 * A did:vh or did:webvh version that cannot exist: not of the form
 * `<number>-<entry hash>` numbered from 1, numbered past the profile's limit
 * on versions of one signer DID (P14.13; this profile never verifies it,
 * P7.7), or after a deactivated version the verifier holds, which is terminal (P9.15; originals-spec #51, merged).
 */
function impossibleVersion(entry: LogEntry, histories: AuthorHistory[]): boolean {
  const ref = signerRefOf(entry);
  const history = ref ? histories.find((h) => h.did === ref.did) : undefined;
  if (!ref || !history || history.method === "did:btco") return false;
  // `<number>-<entry hash>`, numbered from 1: anything else is no version of a did:vh or did:webvh.
  if (!/^[1-9][0-9]*-[1-9A-HJ-NP-Za-km-z]+$/.test(ref.versionId)) return true;
  const n = versionNumberOf(ref.versionId);
  const newest = history.versions[history.versions.length - 1];
  return n > ORIGINALS_LIMITS.authorVersions || (newest?.deactivated === true && n > newest.versionNumber);
}

/**
 * Whether the signer's history shows the version an entry inscribed on the
 * anchoring sat names is not that DID's, in the anchoring inscription or
 * after it (P9.15; originals-spec #51, merged): for a did:vh or did:webvh, numbered at or below the
 * newest verified version but not in the history; for a did:btco whose sat
 * was read in full through the inscription, not among its versions.
 */
function notInHistory(entry: LogEntry, inscription: SatInscription, histories: AuthorHistory[]): boolean {
  const ref = signerRefOf(entry);
  const history = ref ? histories.find((h) => h.did === ref.did) : undefined;
  const newest = history?.versions[history.versions.length - 1];
  if (!ref || !history || !newest || history.versions.some((v) => v.versionId === ref.versionId)) return false;
  return history.method === "did:btco" ? btcoReadThrough(history, inscription) : versionNumberOf(ref.versionId) <= newest.versionNumber;
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
  /** The anchoring inscription's chain position, when anchored: entries in it are checked against signer DID state there (P5.13). */
  anchorPosition?: ChainPosition;
}

type Verify = (entries: unknown[], options?: { unauthorized?: ReadonlySet<number> }) => Promise<LogVerification>;

/** Failures that mean the signer DID version the entry names is not verified here (P9.15). */
const UNVERIFIED_CODES = new Set(["AUTHOR_VERSION_UNAVAILABLE", "AUTHOR_HISTORY_MISSING", "EDITOR_HISTORY_MISSING"]);

const passes = (v: LogVerification, length: number) => !v.failure && v.entries.length === length;
const CHAIN_CODES = new Set(["ENTRY_HASH_MISMATCH", "VERSION_NUMBER", "SCID_MISMATCH"]);

interface Anchoring {
  read: SatRead;
  inscription: SatInscription;
  entries: LogEntry[];
  original: string;
}

export interface AssembleOptions {
  /**
   * The anchor reported before (P9.16): a different anchor now is reported as
   * a change. An inscription it lists as unverifiable that is now accepted is
   * reported as a change of head (P9.15).
   */
  previousAnchor?: RetainedAnchor;
  /** The head reported before, for `headChange` (P9.15). */
  previousHead?: string;
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
  const unverifiable: AnchoringReport["unverifiable"] = [];
  const rejectedByAuthorState = new Set<string>();
  const ignore = (sat: string, i: SatInscription | string, reason: IgnoredReason, entry?: LogEntry, code?: string, waitingOn?: string) => {
    ignored.push({ sat, inscription: typeof i === "string" ? i : i.id, ...(entry?.versionId ? { versionId: entry.versionId } : {}), reason, ...(code ? { code } : {}), ...(waitingOn ? { waitingOn } : {}) });
    if (entry && (reason === "author-key-not-valid-at-inscription-time" || reason === "author-deactivated-at-inscription-time")) rejectedByAuthorState.add(entry.versionId);
  };

  // One merged read per alias, from every index read supplied for it (P9.10).
  const byAlias = new Map<string, SatEvidence[]>();
  for (const e of evidence) {
    const did = parseBtcoAlias(e.sat).did;
    byAlias.set(did, [...(byAlias.get(did) ?? []), e]);
  }
  // A disputed inscription no index reports as an Originals inscription cannot be an entry, so it
  // holds back nothing after it; a disputed Originals inscription does (P9.10; L3).
  const couldCount = (reports: SatInscription[]) => reports.some((r) => r.mediaType === ORIGINALS_INSCRIPTION_TYPE);
  const reads = [...byAlias].map(([did, list]) => readSat(did, list, { couldCount }));
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
    if (i.unsupported === "not-read") {
      // What the index reports already rejects it, read or not (P9.17). PROVISIONAL.
      if (i.metadataPresent) return void ignore(sat, i, "carries-metadata");
      if ((i.contentLength ?? 0) > ORIGINALS_INSCRIPTION_MAX_BYTES) return void ignore(sat, i, "too-large");
      throw new OriginalsError("incomplete-evidence", "SAT_READ_INCOMPLETE", `inscription ${i.id} on ${sat} was not read in full (P9.17)`);
    }
    if (i.unsupported) return void ignore(sat, i, "unsupported-encoding");
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
    // An entry naming a version its signer's history shows is not that DID's is rejected, here
    // as after the anchor, not incomplete identity evidence (P9.15; originals-spec #51, merged).
    if (entries.some((e) => impossibleVersion(e, histories))) return ["invalid-entry", "AUTHOR_VERSION_IMPOSSIBLE"];
    const wrong = entries.find((e) => notInHistory(e, i, histories));
    if (wrong) return ["invalid-entry", "AUTHOR_VERSION_NOT_IN_HISTORY"];
    const v = await verify(entries);
    if (!passes(v, entries.length)) {
      const code = v.failure?.error.code;
      return [code && CHAIN_CODES.has(code) ? "not-one-log" : "invalid-entry", code];
    }
    for (const e of entries.slice(0, -1)) {
      const before = checkBeforeAnchor(e, i, histories);
      if (before) return [before];
    }
    const author = checkAtInscriptionTime(last, i, histories);
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
    // Without an anchor on Bitcoin the copy's anchoring entry and what follows are not established,
    // so the head is the last entry before it (claimed ordering, P7.6), as for not-anchored. With no
    // Bitcoin evidence at all the copy is the local committed log, reported whole and not current
    // (bitcoin-evidence-missing): the SDK extends it locally before inscribing (P9.18).
    const local = status === "unverified" && evidence.length === 0;
    const entries = !copy ? [] : local || copyAnchor < 0 ? copy : copy.slice(0, copyAnchor);
    const change = status === "not-anchored" && options.previousAnchor ? { previous: options.previousAnchor, current: null } : null;
    inChainOrder();
    return {
      entries,
      report: {
        sat: named ?? reads[0]?.alias.did ?? "", status, anchor: null, conflicting: [], accepted: [], ignored, unverifiable, disputed,
        indexes: reads[0]?.indexes ?? [], copy: copy ? "used" : "absent", superseded: 0, change, headChange: null, uniqueness: "not-established", tip: reads[0]?.tip ?? null,
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
  /**
   * An inscription after the anchor whose signer could not be verified: never incomplete identity
   * evidence for the accepted head, which it cannot change (P9.12, P9.15).
   */
  /** Whether the inscription was reported unverifiable. */
  const ignoreLater = (on: string, i: SatInscription, entry: LogEntry, reason: IgnoredReason, code?: string): boolean => {
    const unverified = reason === "author-version-unavailable" || (code !== undefined && UNVERIFIED_CODES.has(code));
    if (!unverified) {
      ignore(on, i, reason, entry, code);
      return false;
    }
    const later = unverifiedLater(entry, i, histories);
    ignore(on, i, later.reason, entry, later.code);
    if (later.reason !== "later-inscription-unverifiable") return false;
    unverifiable.push({ sat: on, inscription: i.id, ...(entry.versionId ? { versionId: entry.versionId } : {}), signer: later.ref?.did ?? "", signerVersionId: later.ref?.versionId ?? "" });
    return true;
  };
  for (const r of rejected) {
    const after = r.read === read && chainOrder(r.inscription, chosen.inscription) > 0;
    const last = r.entries[r.entries.length - 1];
    if (after && r.entries.length > 1) ignore(sat, r.inscription, "more-than-one-entry", last);
    else if (!after && chainOrder(r.inscription, chosen.inscription) > 0) ignoreLater(r.read.alias.did, r.inscription, last, r.reason, r.code);
    else if (!after) ignore(r.read.alias.did, r.inscription, r.reason, last, r.code);
  }

  // After the anchor: one entry per inscription, extending the head at a greater height (P9.13).
  // Chain order decides: while an inscription extending the head is unverifiable, a later one
  // extending the same head waits on it (P9.15; originals-spec #51, merged).
  const head: LogEntry[] = [...chosen.entries];
  const accepted: Placed[] = [];
  let lastHeight = chosen.inscription.height;
  // `blocking` is the first unverifiable inscription extending the head; `chain` is the head with
  // it and the publications waiting on top of it, which are followed once it is accepted (P9.15;
  // originals-spec #51, merged). Each candidate is judged in full first: one that would be
  // rejected on its own is rejected while another blocks; one that would be accepted, or is
  // unverifiable itself, waits. On the chain only the chain's own authorization is set aside.
  type Verdict = { kind: "valid" } | { kind: "unverifiable"; ref?: AuthorRef } | { kind: "rejected"; reason: IgnoredReason; code?: string };
  const asUnverified = (entry: LogEntry, i: SatInscription, reason: IgnoredReason, code?: string): Verdict => {
    if (reason !== "author-version-unavailable" && !(code !== undefined && UNVERIFIED_CODES.has(code))) return { kind: "rejected", reason, ...(code ? { code } : {}) };
    const later = unverifiedLater(entry, i, histories);
    return later.reason === "later-inscription-unverifiable" ? { kind: "unverifiable", ...(later.ref ? { ref: later.ref } : {}) } : { kind: "rejected", reason: later.reason, ...(later.code ? { code: later.code } : {}) };
  };
  const range = (from: number, to: number) => new Set(Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k));
  const judge = async (base: LogEntry[], entry: LogEntry, i: SatInscription): Promise<Verdict> => {
    const chainAside = range(head.length, base.length);
    const v = await verify([...base, entry], chainAside.size > 0 ? { unauthorized: chainAside } : undefined);
    if (!passes(v, base.length + 1)) {
      const code = v.failure?.error.code;
      if (code === "ENTRY_HASH_MISMATCH" || (v.failure?.index ?? base.length) < base.length) return { kind: "rejected", reason: "does-not-extend-head", ...(code ? { code } : {}) };
      if (code !== undefined && UNVERIFIED_CODES.has(code)) {
        // Rejected, not unverifiable, when it fails a rule not depending on that version.
        const rest = await verify([...base, entry], { unauthorized: range(head.length, base.length + 1) });
        if (!passes(rest, base.length + 1)) {
          const c = rest.failure?.error.code;
          return { kind: "rejected", reason: c === "ENTRY_HASH_MISMATCH" ? "does-not-extend-head" : "invalid-entry", ...(c ? { code: c } : {}) };
        }
      }
      return asUnverified(entry, i, "invalid-entry", code);
    }
    const author = checkAtInscriptionTime(entry, i, histories);
    return author ? asUnverified(entry, i, author) : { kind: "valid" };
  };
  const listUnverifiable = (i: SatInscription, entry: LogEntry, ref?: AuthorRef) =>
    unverifiable.push({ sat, inscription: i.id, ...(entry.versionId ? { versionId: entry.versionId } : {}), signer: ref?.did ?? "", signerVersionId: ref?.versionId ?? "" });
  let blocking: { id: string; chain: LogEntry[] } | null = null;
  for (const { inscription: i, entry } of singles.get(read)!) {
    if (chainOrder(i, chosen.inscription) <= 0) continue;
    if (i.height <= lastHeight) {
      ignore(sat, i, "not-above-previous-height", entry);
      continue;
    }
    const n = versionNumberOf(entry.versionId);
    const base = n === head.length + 1 ? head : blocking && n === blocking.chain.length + 1 ? blocking.chain : null;
    if (!base) {
      ignore(sat, i, "does-not-extend-head", entry);
      continue;
    }
    const verdict = await judge(base, entry, i);
    if (verdict.kind === "rejected") {
      ignore(sat, i, verdict.reason, entry, verdict.code);
      continue;
    }
    if (blocking) {
      if (verdict.kind === "unverifiable") listUnverifiable(i, entry, verdict.ref);
      ignore(sat, i, "waiting-for-earlier-unverifiable", entry, undefined, blocking.id);
      if (base === blocking.chain) blocking.chain = [...blocking.chain, entry];
      continue;
    }
    if (verdict.kind === "unverifiable") {
      ignore(sat, i, "later-inscription-unverifiable", entry);
      listUnverifiable(i, entry, verdict.ref);
      blocking = { id: i.id, chain: [...head, entry] };
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
  // P9.15: a head that moves from the retained one because an inscription's verifiability changed
  // is reported, whichever way it moves (originals-spec #51, merged).
  const before = new Set(previous && !change ? previous.unverifiable ?? [] : []);
  const now = new Set(unverifiable.map((u) => u.inscription));
  const onSat = new Set(read.inscriptions.map((x) => x.id));
  const resolved = [...before].filter((id) => !now.has(id) && onSat.has(id));
  const vanished = [...before].filter((id) => !onSat.has(id));
  const retainedNumber = options.previousHead !== undefined ? versionNumberOf(options.previousHead) : NaN;
  // Accepted before: by the retained ids where the anchor was retained with them, else by number.
  const acceptedBefore = previous && !change && previous.accepted ? new Set(previous.accepted) : null;
  const unverified = unverifiable
    .filter((u) => !before.has(u.inscription) && (acceptedBefore ? acceptedBefore.has(u.inscription) : u.versionId !== undefined && versionNumberOf(u.versionId) <= retainedNumber))
    .map((u) => u.inscription);
  const currentHead = head[head.length - 1].versionId;
  const moved = options.previousHead !== undefined && currentHead !== options.previousHead;
  const headChange = moved && (resolved.length > 0 || unverified.length > 0 || vanished.length > 0)
    ? { previous: options.previousHead ?? null, current: currentHead, verified: accepted.filter((a) => versionNumberOf(a.versionId) > retainedNumber), resolved, unverified, vanished }
    : null;
  return {
    entries: head,
    report: {
      sat, status: "anchored", anchor, conflicting, accepted, ignored, unverifiable, disputed, indexes: read.indexes, copy: copyStatus, superseded, change,
      headChange, uniqueness: "not-established", tip: read.tip,
    },
    anchorPosition: { height: chosen.inscription.height, transactionIndex: chosen.inscription.transactionIndex, inscriptionIndex: chosen.inscription.inscriptionIndex },
    owner: owner
      ? { status: "provisional", sat, output: owner.output, ...(owner.address ? { address: owner.address } : {}), confirmations: owner.confirmations, indexes: read.indexes }
      : null,
    ownerDisputed: read.ownerDisputed,
    rejectedByAuthorState,
  };
}
