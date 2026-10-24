/**
 * Fresh verification of an Original (spec section 7). The report keeps history
 * validity, author binding, identity evidence, resource availability,
 * freshness and ordering separate. Missing resource bytes are reported as
 * unavailable content and never fail the log (P7.3, P7.4, P9.18). No private
 * key or network is involved (P7.3).
 *
 * An Original that is not anchored is never current, and its signers are never
 * reported as currently authorized, however fresh the evidence (P7.10;
 * originals-spec #46): off Bitcoin nothing shows that a newer entry or another
 * branch does not exist. A valid unanchored Original is reported as valid as
 * of its verified checkpoint (`validAsOf`), with the latest versionId relied
 * on for each signer DID and when that history was obtained. An entry whose
 * key the latest verified state of its signer's DID no longer lists, or any
 * entry once the author DID is deactivated, is historically authorized only
 * (`historicallyAuthorizedOnly`, P7.9, P6.5, P5.18); that does not invalidate
 * the checkpoint, and every result that includes such an entry says so.
 *
 * Freshness (P7.6, P7.8): a caller may supply other copies of the asset log
 * and the highest versionIds it has verified before, for the Original and for
 * each author DID. Copies are compared as VH-Log describes, but the supplied
 * log is always the one reported: a log shorter than the retained versionId or
 * than another valid copy is stale; one that diverges from either is a fork. Forks stay unresolved: every branch is reported and
 * none is current, whatever its timestamps (P2.1, P6.6; owner decision Q5).
 * Only anchoring settles a fork (P9.16, plan 011 PR 9).
 */
import { OriginalsError, type ErrorCategory } from "../errors.js";
import { isJsonObject, type JsonObject } from "../json/index.js";
import {
  compactLineError,
  parseLog,
  resolveCopies,
  verifyLog,
  verifyLogText,
  type CopyReport,
  type LogCopy,
  type LogLimits,
  type LogVerification,
  type VerifiedEntry,
} from "../log/index.js";
import { checkAlias, aliasTarget, type AliasEvidence, type AliasReport } from "./alias.js";
import { anchoringIndex, assembleFromBitcoin, type AnchoringReport, type OwnershipReport, type RetainedAnchor } from "./bitcoin.js";
import { chainOrder, type ChainPosition, type SatEvidence } from "./btco.js";
import { authorKey, stillAuthorized, verifyAuthorHistory, versionNumberOf, type AuthorDidEvidence, type AuthorHistory, type EvidenceSource } from "./author.js";
import { didWebvhLogUrl } from "../webvh/index.js";
import { deriveDocument, exactNumberError, originalsSpecialisation } from "./profile.js";
import { ORIGINALS_LIMITS, ORIGINALS_METHOD, resourceDigest, signerOf, type AssetState, type EntryState } from "./state.js";

export interface VerifyOriginalOptions {
  /**
   * The asset log: `did.jsonl` text or parsed entries. Optional with Bitcoin
   * evidence: the anchoring sat carries an anchored Original's whole log, and
   * a copy that differs from it is ignored (P9.17, P9.18).
   */
  log?: string | unknown[];
  /** Author DID histories. Missing history is incomplete evidence, never trust in the key (P5.6). */
  authors: AuthorDidEvidence[];
  /** Resource bytes by digest. */
  bytes?: Record<string, Uint8Array> | ((digest: string) => Uint8Array | undefined);
  /** Verify this exact checkpoint instead of the head (P3.2). */
  checkpoint?: string;
  /** Other copies of the asset log, compared with the supplied one (VH-Log "Comparing Copies"). */
  copies?: LogCopy[];
  /** The highest versionIds verified before, for the Original and per author DID (P7.8). */
  retained?: RetainedVersions;
  /** did:webvh alias logs, to confirm the aliases the asset state lists (P3.6). */
  aliases?: AliasEvidence[];
  /**
   * What indexes read from the anchoring sat, and from any other sat known to
   * carry an anchoring inscription for this Original, one read per index used
   * (plan 012 §3.4; P9.10, P9.11). Bitcoin then decides the whole log: the
   * anchoring inscription carries it through the anchoring entry, and each
   * later inscription one entry (P9.12-P9.17). A supplied log is only a copy,
   * compared and otherwise ignored.
   */
  bitcoin?: SatEvidence[];
  now?: number | Date;
  limits?: LogLimits & { maxAuthorVersions?: number };
}

export interface RetainedVersions {
  original?: string;
  authors?: Record<string, string>;
  /** The anchor reported before: an anchor that differs now is reported as a change, never silently (P9.16). */
  anchor?: RetainedAnchor;
}

/**
 * Whether a signer DID log's freshness was established (P7.8; owner decision,
 * 23 Oct 2026). established: the log was obtained, without redirects, at a
 * location (P5.14), and the DID's own witnesses approve its latest version,
 * whose `id` names that location. not-established: nothing shows it is the
 * latest; the DID may have a newer version, for example one that removes a
 * key, that the verifier has not seen. stale: shorter than a retained
 * versionId. None of these makes an unanchored Original current (P7.10).
 * Watchers are not consulted: this verifier makes no requests of its own.
 */
export type Freshness = "established" | "not-established" | "stale";

/**
 * Where, when and as of which version a signer DID history was obtained
 * (P7.8): what a report states, whatever its freshness.
 */
export interface IdentityObtained {
  /** The URL the log was retrieved from (`AuthorDidEvidence.retrievedFrom`), or null when it was not retrieved from a location. */
  location: string | null;
  /** As the evidence states it (`AuthorDidEvidence.obtainedAt`); null when it does not say. */
  obtainedAt: string | null;
  source: EvidenceSource | null;
  /** The latest verified versionId of that history. */
  latestVersionId: string | null;
  /** Whether the DID's own witnesses approve that version. */
  witnessed: boolean;
  /**
   * A did:webvh log whose latest version names another location than the
   * one it was fetched from, or for a copy than the identity DID: where the
   * DID now is, by that version's `id` (P5.14).
   */
  movedTo?: string;
  /**
   * With `movedTo`: the log there was not obtained. For a did:webvh log fetched
   * from a location that leaves freshness not established (P7.8); a copy from
   * a package or a host keeps the freshness its witnesses give it.
   */
  movedLog?: "not-obtained";
}

/** A signer DID a result relies on: the latest versionId used, and when and where that history was obtained (P7.8, P7.10). */
export interface SignerReliance {
  did: string;
  role: "author" | "editor";
  versionId: string | null;
  /** As the evidence states it (`AuthorDidEvidence.obtainedAt`); null when it does not say. */
  obtainedAt: string | null;
  source: EvidenceSource | null;
  /** The URL the history was retrieved from, or null (`IdentityObtained.location`). */
  location: string | null;
}

/**
 * P7.10: what a valid result is valid as of: `checkpoint`, judged with the
 * signer DID versions listed. It is set whenever the checkpoint verifies,
 * anchored or not and whether or not the Original is current; for an
 * unanchored Original it is all the result shows, since that is never
 * current.
 */
export interface ValidAsOf {
  checkpoint: string;
  /** The author first, then each editor that signed an entry through the checkpoint. */
  signers: SignerReliance[];
}

/**
 * P7.9, P6.5, P5.18: an entry through the checkpoint that is historically
 * authorized only. It may have been signed after its key was removed or the
 * DID deactivated, so it shows only that the key was authorized at the
 * version it names. It does not invalidate the checkpoint.
 */
export interface HistoricalAuthorization {
  versionId: string;
  /** The signer DID: the author, or the editor of an editor entry. */
  did: string;
  role: "author" | "editor";
  reason: "key-not-in-latest-signer-document" | "author-did-deactivated" | "signer-did-deactivated";
}

/** Divergent valid histories of one Original. No branch is current (Q5). */
export interface OriginalsFork {
  /** The version number of the first entry at which the branches differ. */
  version: number;
  /** Each branch, by where it came from (`supplied`, a copy's source, or `retained`) and its entry at `version`. */
  branches: Array<{ source: string; versionId: string }>;
}

export interface ResourceVersion {
  resource: string;
  /** Derived from accepted digest changes (P4.4). */
  version: number;
  digest: string;
  mediaType: string;
  size: number;
  /** The entry that introduced these bytes. */
  versionId: string;
  bytes: "verified" | "missing" | "mismatch";
}

/** Identity evidence for one editor DID the report relied on (P7.8, P5.18). */
export interface SignerEvidence {
  did: string;
  status: "complete" | "incomplete";
  latestVersionId: string | null;
  freshness: Freshness;
  /** Where, when and as of which version this DID's history was obtained (P7.8). */
  obtained: IdentityObtained;
  /** The retained versionId for this DID, when one was supplied. */
  retainedVersionId: string | null;
  deactivated: boolean;
  failure?: { code: string; message: string };
}

export interface ReportFailure {
  index: number;
  versionId?: string;
  category: ErrorCategory;
  code: string;
  message: string;
}

export interface OriginalsReport {
  profile: typeof ORIGINALS_METHOD;
  /** The Original's did:vh, once its genesis verifies. */
  original: string | null;
  /** The verified checkpoint reported on, or null when none could be. */
  checkpoint: string | null;
  /** The last verified entry. */
  head: string | null;
  history: { status: "valid" | "invalid" | "incomplete" | "limit-exceeded"; entries: number; failure?: ReportFailure };
  authorBinding: { status: "valid" | "failed" | "incomplete" };
  identityEvidence: {
    status: "complete" | "incomplete";
    author: string | null;
    latestVersionId: string | null;
    freshness: Freshness;
    /** Where, when and as of which version the author DID's history was obtained (P7.8). */
    obtained: IdentityObtained;
    /** The retained versionId for the author DID, when one was supplied. */
    retainedVersionId: string | null;
    deactivated: boolean;
    failure?: { code: string; message: string };
    /**
     * Each editor DID that signed a verified entry, or whose missing history
     * stopped verification (P7.1, P7.8). The fields above are the author's;
     * `status` is incomplete when the author's or any editor's evidence is.
     */
    editors: SignerEvidence[];
  };
  /**
   * Content availability, reported separately (P7.4): `partial` lists the missing resource
   * versions and is not a verification failure (P7.3, P9.18); `digest-failure` is.
   */
  resources: { status: "available" | "partial" | "digest-failure"; versions: ResourceVersion[]; missing: ResourceVersion[]; failures: ResourceVersion[] };
  /**
   * The asset log against the retained versionId and other copies (P7.6):
   * stale when it falls short of either; otherwise not established, because
   * off Bitcoin nothing shows it is the latest (P7.10).
   */
  assetFreshness: { status: Freshness | "anchored"; retainedVersionId: string | null; copies: CopyReport[] };
  fork: OriginalsFork | null;
  /**
   * Each alias the checkpoint's state lists, and whether it is confirmed in both
   * directions (P3.6). An unconfirmed alias does not affect the Original itself.
   */
  aliases: AliasReport[];
  /** Present when the log names an anchoring sat or Bitcoin evidence was supplied (P9.10-P9.16). */
  anchoring: AnchoringReport | null;
  /** The anchoring sat's holder: never authority, always provisional (P9.11, P9.12). */
  ownership: OwnershipReport | null;
  /** Anchored from the anchoring entry on (P9.13); claimed before it and for unanchored Originals (P7.6). */
  ordering: "claimed" | "anchored";
  deactivated: boolean;
  state: AssetState | null;
  /** The derived DID document at the checkpoint (P3.8). */
  document: JsonObject | null;
  /**
   * P7.10: set when the checkpoint verifies: valid history, author binding,
   * complete identity evidence, no failed digest and no unresolved fork. A
   * stale prefix is still valid as of its own checkpoint (C12-22). Null
   * otherwise.
   */
  validAsOf: ValidAsOf | null;
  /** P7.9: the entries through the checkpoint that are historically authorized only, oldest first. */
  historicallyAuthorizedOnly: HistoricalAuthorization[];
  /** Never true for an Original that is not anchored (P7.10). */
  current: boolean;
  /**
   * What a current result is shown with, never dropped (section 7; originals-spec #51, merged):
   * `head-changed` when the head moved from the retained one because an
   * inscription's verifiability changed (`anchoring.headChange` says how and why),
   * `unverifiable-inscriptions` when inscriptions after the anchor are unverifiable,
   * `publications-waiting` when publications wait on one of them (P9.15). Neither stops the
   * accepted state being current.
   */
  notices: Array<"head-changed" | "unverifiable-inscriptions" | "publications-waiting">;
  /** Why the result is not current: `not-anchored` for every unanchored Original, and anything else that applies. */
  reasons: string[];
  /**
   * The versionIds to retain after this verification, never lower than those
   * supplied, and unchanged by a fork or stale evidence; and, for an anchored
   * Original, the anchor reported, so a later change of anchor is reported
   * rather than silent (P9.16), with the inscriptions reported unverifiable,
   * so accepting one later is a reported change of head (P9.15).
   */
  retain: { original: string | null; authors: Record<string, string>; anchor?: RetainedAnchor };
}

function toFailure(index: number, versionId: string | undefined, error: OriginalsError): ReportFailure {
  return { index, ...(versionId ? { versionId } : {}), category: error.category, code: error.code, message: error.message };
}

function historyStatus(failure?: ReportFailure): OriginalsReport["history"]["status"] {
  if (!failure) return "valid";
  if (failure.category === "limit-exceeded") return "limit-exceeded";
  if (failure.category === "incomplete-evidence") return "incomplete";
  return "invalid";
}

/** The did:webvh log URL of `did`, or undefined when it has none. */
function logUrl(did: string): string | undefined {
  try {
    return didWebvhLogUrl(did);
  } catch (error) {
    if (error instanceof OriginalsError) return undefined;
    throw error;
  }
}

function obtained(did: string | null, authors: AuthorDidEvidence[], histories: AuthorHistory[]): IdentityObtained {
  const evidence = did ? authors.find((a) => a.did === did) : undefined;
  const h = did ? histories.find((x) => x.did === did) : undefined;
  const latest = h?.versions[h.versions.length - 1];
  return {
    location: evidence?.retrievedFrom ?? null,
    obtainedAt: evidence?.obtainedAt ?? null,
    source: evidence?.source ?? null,
    latestVersionId: latest?.versionId ?? null,
    witnessed: latest?.witnessed === true,
    ...movedFrom(evidence, latest?.document.id),
  };
}

/**
 * P5.14: a did:webvh log whose latest version's `id` names another location
 * than the one it was fetched from (or, for a copy from a package or a host,
 * than the identity DID itself) shows the identity moved, and the log there
 * was not obtained, or it would be the one reported. This only reports the
 * move; a copy's freshness is still judged by its witnesses (P7.8; owner
 * decision on #993's review).
 */
function movedFrom(evidence: AuthorDidEvidence | undefined, latestId: unknown): Pick<IdentityObtained, "movedTo" | "movedLog"> {
  if (!evidence || typeof latestId !== "string" || !latestId.startsWith("did:webvh:")) return {};
  const from = evidence.retrievedFrom ?? logUrl(evidence.did);
  return logUrl(latestId) === from ? {} : { movedTo: latestId, movedLog: "not-obtained" };
}

const SOURCE_TEXT: Record<EvidenceSource, string> = {
  package: "the evidence package",
  host: "the host's snapshot",
  fetched: "a retrieval",
  retained: "this verifier's store",
  supplied: "the caller",
};

/**
 * P7.8 (owner decision, 23 Oct 2026; originals-spec #51, merged):
 * a plain statement of a signer DID's
 * freshness for people. It always says where and when the history was
 * obtained and its latest version; unless freshness is established it says
 * the DID may have a newer version, for example one that removes a key, that
 * the verifier has not seen.
 */
export function describeFreshness(
  did: string,
  evidence: { freshness: Freshness; obtained: IdentityObtained; retainedVersionId?: string | null },
): string {
  const { freshness, obtained: o } = evidence;
  const where = o.location ?? (o.source ? SOURCE_TEXT[o.source] : "an unstated source");
  const when = o.obtainedAt ?? "an unstated time";
  if (o.latestVersionId === null) return `No verified history of ${did} was obtained (from ${where} at ${when}).`;
  const moved = o.movedTo ? ` That version says the DID is now at ${o.movedTo}; its log there was not obtained.` : "";
  const seen = `The history of ${did} was obtained from ${where} at ${when}; its latest version there is ${o.latestVersionId}.${moved}`;
  if (freshness === "established") return `${seen} That version is approved by the DID's own witnesses, which establishes its freshness.`;
  const newer = "The DID may have a newer version, for example one that removes a key, that this verifier has not seen.";
  if (freshness === "stale") return `${seen} It is older than version ${evidence.retainedVersionId ?? "unknown"}, which this verifier has seen before. ${newer}`;
  return `${seen} Its freshness is not established. ${newer}`;
}

/**
 * P14.2 (the reader rule is originals-spec #51, merged): each line of an asset log is compact JSON
 * ending in a single LF. A copy that is not is treated like one that does not parse; verified as the
 * log itself, the line is reported (LOG_LINE_FORMAT). did:vh and did:webvh
 * signer logs keep their own method's rules.
 */
function checkLogForm(text: string): void {
  const bad = !text.endsWith("\n") || text.slice(0, -1).split("\n").some((line) => compactLineError(line) !== undefined || exactNumberError(line) !== undefined);
  if (bad) throw new OriginalsError("invalid-evidence", "LOG_LINE_FORMAT", "the asset log is not compact JSON Lines, each line ending in one LF (P14.2)");
}

function lookup(bytes: VerifyOriginalOptions["bytes"], digest: string): Uint8Array | undefined {
  if (!bytes) return undefined;
  return typeof bytes === "function" ? bytes(digest) : (Object.prototype.hasOwnProperty.call(bytes, digest) ? bytes[digest] : undefined);
}

/**
 * Resource versions through the prefix, with each version's bytes checked (P4.3, P4.4, P7.4).
 * An added resource starts at version 1; a removal adds no version, and a removed resource's
 * earlier versions stay listed and checked (P4.1, P8.3; originals-spec #49).
 */
function resourceVersions(prefix: VerifiedEntry[], bytes: VerifyOriginalOptions["bytes"]): ResourceVersion[] {
  const out: ResourceVersion[] = [];
  const counts = new Map<string, number>();
  for (const v of prefix) {
    const state = v.entry.state as unknown as EntryState;
    for (const t of state.transitions) {
      if (t.to === null) continue;
      const d = state.asset.resources.find((r) => r.id === t.resource)!;
      const version = (counts.get(d.id) ?? 0) + 1;
      counts.set(d.id, version);
      const supplied = lookup(bytes, d.digest);
      const check = supplied === undefined ? "missing" : supplied.length === d.size && resourceDigest(supplied) === d.digest ? "verified" : "mismatch";
      out.push({ resource: d.id, version, digest: d.digest, mediaType: d.mediaType, size: d.size, versionId: v.entry.versionId, bytes: check });
    }
  }
  return out;
}

/** The higher of the verified head and the retained versionId; a fork keeps the retained one. */
function retainOriginal(head: string | undefined, retained: string | undefined, forked: boolean): string | null {
  if (forked || head === undefined) return retained ?? null;
  return retained !== undefined && versionNumberOf(retained) > versionNumberOf(head) ? retained : head;
}

export async function verifyOriginal(options: VerifyOriginalOptions): Promise<OriginalsReport> {
  const reasons: string[] = [];
  const histories: AuthorHistory[] = [];
  const identityFailures: Array<{ code: string; message: string }> = [];
  const failuresByDid = new Map<string, { code: string; message: string }>();
  const noteFailure = (did: string, failure: { code: string; message: string }) => {
    identityFailures.push(failure);
    if (!failuresByDid.has(did)) failuresByDid.set(did, failure);
  };
  // P5.13 (originals-spec #51, merged): a did:btco history that stops at an unread or
  // disputed inscription is missing evidence only for an entry whose check depends on the history
  // past it. Held here until the anchor is known; inscriptions after it are unverifiable (P9.15).
  const heldBack: Array<{ did: string; before: ChainPosition; failure: { code: string; message: string } }> = [];
  const retainedAuthors = { ...options.retained?.authors };
  const staleAuthors = new Set<string>();
  const forkedAuthors = new Set<string>();
  for (const evidence of options.authors) {
    try {
      const h = await verifyAuthorHistory(evidence, { now: options.now, maxVersions: options.limits?.maxAuthorVersions });
      histories.push(h);
      if (h.failure) {
        const failure = { code: h.failure.error.code, message: `DID ${h.did}: ${h.failure.error.message}` };
        const gap = h.method === "did:btco" && h.establishedBefore && (failure.code === "AUTHOR_SAT_READ_INCOMPLETE" || failure.code === "AUTHOR_PLACEMENT_DISPUTED");
        if (gap) heldBack.push({ did: h.did, before: h.establishedBefore!, failure });
        else noteFailure(h.did, failure);
      }
      const retained = retainedAuthors[h.did];
      if (retained !== undefined) {
        // By versionId: a did:btco version is an inscription id, with no number in it.
        const found = h.versions.some((v) => v.versionId === retained);
        const sameNumber = h.versions[versionNumberOf(retained) - 1];
        if (!found && !sameNumber) staleAuthors.add(h.did);
        else if (!found) {
          forkedAuthors.add(h.did);
          noteFailure(h.did, { code: "AUTHOR_DID_FORK", message: `DID ${h.did} diverges from the retained version ${retained}` });
        }
      }
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
      noteFailure(evidence.did, { code: error.code, message: error.message });
    }
  }

  const verifyOptions = {
    specialisation: originalsSpecialisation(histories),
    now: options.now,
    limits: { maxEntries: ORIGINALS_LIMITS.entries, maxEntryBytes: ORIGINALS_LIMITS.entryBytes, ...options.limits },
  };
  // An anchored Original: Bitcoin decides the log (plan 012 §3.4; P9.17).
  const onSats = (options.bitcoin?.length ?? 0) > 0;
  if (options.log === undefined && !onSats) throw new OriginalsError("incomplete-evidence", "LOG_MISSING", "neither an asset log nor Bitcoin evidence was supplied");
  let input: string | unknown[] = options.log ?? [];
  let assembly: Awaited<ReturnType<typeof assembleFromBitcoin>> | null = null;
  let raw: unknown[] | null = null;
  try {
    if (typeof options.log === "string") checkLogForm(options.log);
    raw = options.log === undefined ? null : typeof options.log === "string" ? parseLog(options.log) : options.log;
  } catch (error) {
    if (!(error instanceof OriginalsError)) throw error;
    raw = onSats ? [] : null; // a copy that does not parse is ignored when the sat carries the log
  }
  if (onSats || (raw && anchoringIndex(raw) >= 0)) {
    const previousAnchor = options.retained?.anchor;
    const previousHead = options.retained?.original;
    assembly = await assembleFromBitcoin(raw, options.bitcoin ?? [], (entries, o) => verifyLog(entries, { ...verifyOptions, ...o }), histories, {
      ...(previousAnchor ? { previousAnchor } : {}),
      ...(previousHead !== undefined ? { previousHead } : {}),
    });
    input = assembly.entries;
  }
  const onBitcoin = assembly?.report.status === "anchored" ? assembly.report : null;
  // The entries in the anchoring inscription depend on their signer's history up to it; without an
  // anchor every entry may. A DID that signed none of them leaves no accepted entry depending on the
  // history past its gap; inscriptions after the anchor are unverifiable instead (P5.13, P9.15).
  const anchorLog = onBitcoin ? assembly!.entries.slice(0, anchoringIndex(assembly!.entries) + 1) : Array.isArray(input) ? input : raw ?? [];
  const signedBy = (did: string) => anchorLog.some((e) => {
    const state = (e as { state?: unknown } | null)?.state;
    return isJsonObject(state) && signerOf(state as unknown as EntryState)?.ref?.did === did;
  });
  for (const held of heldBack) {
    const at = onBitcoin ? assembly?.anchorPosition : undefined;
    if (signedBy(held.did) && (!at || chainOrder(at, held.before) >= 0)) noteFailure(held.did, held.failure);
  }
  const supplied = (): Promise<LogVerification> =>
    typeof input === "string" ? verifyLogText(input, { ...verifyOptions, compactLines: true, lineRule: exactNumberError }) : verifyLog(input, verifyOptions);
  let log: LogVerification;
  let fork: OriginalsFork | null = null;
  let copies: CopyReport[] = [];
  let stale = false;
  // Once anchored, Bitcoin decides from the anchor on: a copy can neither fork the log nor
  // make it stale (P9.13, P9.16). A retained version Bitcoin dropped is reported below.
  if (!onBitcoin && ((options.copies?.length ?? 0) > 0 || options.retained?.original !== undefined)) {
    const text = typeof input === "string" ? input : input.map((e) => `${JSON.stringify(e)}\n`).join("");
    const resolution = await resolveCopies({ source: "supplied", log: text }, options.copies ?? [], {
      ...verifyOptions,
      ...(options.retained?.original !== undefined ? { retainedVersionId: options.retained.original } : {}),
    });
    copies = resolution.copies;
    stale = resolution.warnings.some((w) => w.code === "retained-version-not-found");
    if (resolution.fork) fork = { version: resolution.fork.version, branches: resolution.fork.copies };
    // The supplied log is always judged as itself: copies only add fork and freshness
    // evidence, never replace it. A valid copy ahead of it makes it stale (P7.6). On a fork the
    // report describes the supplied branch, never as current.
    log = await supplied();
    if (!resolution.fork && resolution.reference && resolution.reference.entries.length > log.entries.length) stale = true;
  } else {
    log = await supplied();
  }
  const failure = log.failure ? toFailure(log.failure.index, log.failure.versionId, log.failure.error) : undefined;

  const head = log.entries[log.entries.length - 1];
  // Anchored ordering only for what Bitcoin accepted: the anchor and the inscriptions after it.
  const inscribed = new Set(onBitcoin ? [onBitcoin.anchor!.versionId, ...onBitcoin.accepted.map((a) => a.versionId)] : []);
  const anchored = (v: VerifiedEntry | undefined) => v !== undefined && inscribed.has(v.entry.versionId);
  const authorDid = head ? (head.entry.state as unknown as EntryState).author.did : null;
  const history = authorDid ? histories.find((h) => h.did === authorDid) : undefined;
  const latest = history?.versions[history.versions.length - 1];
  const obtainedOf = (did: string | null): IdentityObtained => obtained(did, options.authors, histories);
  /**
   * P7.8 (owner decision, 23 Oct 2026; originals-spec #51, merged):
   * a log obtained at a location establishes freshness only
   * when the DID's own witnesses approve its latest version, and is the identity's latest there
   * only when that version's `id` names the location. It must also be the location the latest
   * entry the identity signed names (P5.14).
   */
  const signerFreshness = (did: string | null): Freshness => {
    if (did && staleAuthors.has(did)) return "stale";
    if (!did) return "not-established";
    const o = obtainedOf(did);
    if (!o.witnessed) return "not-established";
    // The location rule is for a did:webvh log fetched from a location: it is the identity's latest
    // there only when its latest version's `id` names that location, wherever P5.14 sent the reader
    // (the latest verified entry's location, or where a verified log's latest version points). A
    // did:vh log, or one from an evidence package, is judged by its witnesses alone (P7.8; originals-spec #51, merged).
    if (o.location === null || !did.startsWith("did:webvh:")) return "established";
    const h = histories.find((x) => x.did === did);
    const latestId = h?.versions[h.versions.length - 1]?.document.id;
    return typeof latestId === "string" && logUrl(latestId) === o.location ? "established" : "not-established";
  };

  // The editor DIDs relied on: each that signed a verified entry, and one whose missing history stopped verification.
  const editorDids: string[] = [];
  for (const v of log.entries) {
    const editor = (v.entry.state as unknown as EntryState).editor;
    if (editor && !editorDids.includes(editor.did)) editorDids.push(editor.did);
  }
  const stoppedAt = log.failure?.error.details?.did;
  if (log.failure?.error.category === "incomplete-evidence" && typeof stoppedAt === "string" && log.failure.error.details?.role === "editor" && !editorDids.includes(stoppedAt)) {
    editorDids.push(stoppedAt);
  }
  const editors: SignerEvidence[] = editorDids.map((did) => {
    const h = histories.find((x) => x.did === did);
    const last = h?.versions[h.versions.length - 1];
    const stopped = stoppedAt === did ? { code: log.failure!.error.code, message: log.failure!.error.message } : undefined;
    const failure = failuresByDid.get(did) ?? stopped;
    return {
      did,
      status: !h || h.versions.length === 0 || failure || forkedAuthors.has(did) ? "incomplete" : "complete",
      latestVersionId: last?.versionId ?? null,
      freshness: signerFreshness(did),
      obtained: obtainedOf(did),
      retainedVersionId: retainedAuthors[did] ?? null,
      deactivated: last?.deactivated ?? false,
      ...(failure ? { failure } : {}),
    };
  });

  let selected: VerifiedEntry | undefined = head;
  if (options.checkpoint !== undefined) {
    selected = log.entries.find((v) => v.entry.versionId === options.checkpoint);
    if (!selected) reasons.push("checkpoint-not-found");
    else if (selected !== head) reasons.push("checkpoint-is-not-head");
  }
  const prefix = selected ? log.entries.slice(0, selected.versionNumber) : [];
  const versions = resourceVersions(prefix, options.bytes);
  const missing = versions.filter((v) => v.bytes === "missing");
  const mismatched = versions.filter((v) => v.bytes === "mismatch");
  const state = selected ? (selected.entry.state as unknown as EntryState) : undefined;

  const bindingFailed = failure && (failure.category === "author-binding" || failure.category === "unauthorized-key" || failure.category === "outside-grant");
  // P9.15 (originals-spec #47): an inscribed entry naming a signer DID version
  // the verifier has no verified copy of, or none at or after, is incomplete identity evidence (P5.6).
  const versionUnavailable = assembly?.report.ignored.some((i) => i.reason === "author-version-unavailable" || i.code === "AUTHOR_VERSION_UNAVAILABLE") ?? false;
  const identityIncomplete =
    failure?.category === "incomplete-evidence" || identityFailures.length > 0 || !history || editors.some((e) => e.status === "incomplete") || versionUnavailable;
  // With the anchor, the inscriptions reported unverifiable: one accepted later is a reported change of head (P9.15).
  const unverifiableNow = onBitcoin?.unverifiable.map((u) => u.inscription) ?? [];
  const acceptedNow = onBitcoin?.accepted.map((a) => a.inscription) ?? [];
  const retainedAnchor: RetainedAnchor | undefined = onBitcoin
    ? {
      inscription: onBitcoin.anchor!.inscription, sat: onBitcoin.sat, owner: assembly!.owner?.output ?? null,
      ...(unverifiableNow.length > 0 ? { unverifiable: unverifiableNow } : {}), ...(acceptedNow.length > 0 ? { accepted: acceptedNow } : {}),
    }
    : options.retained?.anchor;
  const report: OriginalsReport = {
    profile: ORIGINALS_METHOD,
    original: log.scid ? `did:vh:${log.scid}` : null,
    checkpoint: selected?.entry.versionId ?? null,
    head: head?.entry.versionId ?? null,
    history: { status: historyStatus(failure), entries: log.entries.length, ...(failure ? { failure } : {}) },
    authorBinding: { status: bindingFailed ? "failed" : !head || failure?.category === "incomplete-evidence" ? "incomplete" : "valid" },
    identityEvidence: {
      status: identityIncomplete ? "incomplete" : "complete",
      author: authorDid ?? history?.did ?? null,
      latestVersionId: latest?.versionId ?? null,
      freshness: signerFreshness(authorDid),
      obtained: obtainedOf(authorDid ?? history?.did ?? null),
      retainedVersionId: (authorDid && retainedAuthors[authorDid]) || null,
      deactivated: latest?.deactivated ?? false,
      ...(identityFailures[0] ? { failure: identityFailures[0] } : {}),
      editors,
    },
    resources: {
      status: mismatched.length > 0 ? "digest-failure" : missing.length > 0 ? "partial" : "available",
      versions,
      missing,
      failures: mismatched,
    },
    assetFreshness: {
      // An anchored log is the sat's, as of the read's tip (P9.13, P9.17).
      status: stale ? "stale" : onBitcoin ? "anchored" : "not-established",
      retainedVersionId: options.retained?.original ?? null,
      copies,
    },
    fork,
    aliases: await Promise.all((state?.asset.aliases ?? []).map((did) => checkAlias(`did:vh:${log.scid}`, options.aliases?.find((a) => a.did === did), did, options.now))),
    anchoring: assembly?.report ?? null,
    ownership: assembly?.owner ?? null,
    ordering: anchored(selected) ? "anchored" : "claimed",
    deactivated: log.deactivated,
    state: state?.asset ?? null,
    document: selected ? deriveDocument(prefix) : null,
    validAsOf: null,
    // P7.9 is for entries not inscribed on an anchoring sat; those are checked at their inscription
    // time instead, and entries the anchoring inscription carries against the version they name (P9.15).
    historicallyAuthorizedOnly: onBitcoin === null ? historicallyAuthorizedOnly(prefix, histories, authorDid) : [],
    current: false,
    notices: [],
    reasons,
    // An anchored log whose anchor Bitcoin has not shown is not retained past what was (P9.12).
    // After a change of anchor, the new anchor's branch is the history (P9.16).
    retain: {
      original: assembly && !onBitcoin
        ? (options.retained?.original ?? null)
        : onBitcoin?.change ? (head?.entry.versionId ?? null) : retainOriginal(head?.entry.versionId, options.retained?.original, fork !== null),
      authors: retainedAuthors,
      ...(retainedAnchor ? { anchor: retainedAnchor } : {}),
    },
  };
  for (const h of histories) {
    const latestId = h.versions[h.versions.length - 1]?.versionId;
    if (latestId && !staleAuthors.has(h.did) && !forkedAuthors.has(h.did)) report.retain.authors[h.did] = latestId;
  }

  // P7.10: nothing off Bitcoin shows that a newer entry or another branch does not exist.
  if (!anchored(head)) reasons.push("not-anchored");
  if (failure) reasons.push(`history-${report.history.status}`);
  if (report.identityEvidence.status === "incomplete") reasons.push("identity-evidence-incomplete");
  if (fork) reasons.push("fork-unresolved");
  if (report.assetFreshness.status === "stale") reasons.push("asset-log-older-than-retained");
  if (report.identityEvidence.freshness === "stale") reasons.push("author-history-older-than-retained");
  if (editors.some((e) => e.freshness === "stale")) reasons.push("editor-history-older-than-retained");
  // P6.5: the author DID's deactivation is reported with an unanchored result. An anchored
  // Original's accepted state stays current after it (P9.15).
  if (report.identityEvidence.deactivated && !anchored(head)) reasons.push("author-did-deactivated");
  // P7.9: any result that includes a historically authorized entry says so.
  if (report.historicallyAuthorizedOnly.length > 0) reasons.push("historically-authorized-only");
  if (assembly?.report.status === "unverified") reasons.push("bitcoin-evidence-missing");
  if (assembly?.report.status === "not-anchored") reasons.push("anchor-not-found-on-bitcoin");
  if (assembly && assembly.report.disputed.length > 0) reasons.push("bitcoin-placement-disputed");
  if (assembly?.ownerDisputed) reasons.push("ownership-indexes-disagree");
  if (assembly?.report.change) reasons.push("anchor-changed");
  // A head change from an inscription's verifiability is a notice, not a reason: the state reached
  // is current, and the change is shown with it (P9.15; owner decision on #993's review). One that a
  // reorganization caused is also VH-Log's authoritative-source-changed warning (P9.5).
  const headChange = assembly?.report.headChange;
  if (assembly?.report.status === "anchored" && options.retained?.original !== undefined) {
    const retained = options.retained.original;
    // Only an accepted entry that is unverifiable now can take the retained head away; resolving
    // an unverifiable one never does, and a vanished one is a reorganization (P9.5).
    const explained = headChange && headChange.unverified.length > 0 && headChange.vanished.length === 0;
    if (!explained && !log.entries.some((v) => v.entry.versionId === retained)) reasons.push("authoritative-source-changed");
    if (assembly.rejectedByAuthorState.has(retained)) reasons.push("retroactive-revocation-conflict");
  }
  // P7.3, P7.4, P9.18: the log verifies without resource bytes. Missing bytes are reported in
  // `resources` as unavailable content, never as a failure. Bytes that are supplied are still
  // checked, and a mismatch fails.
  if (report.resources.status === "digest-failure") reasons.push("resources-digest-failure");
  if (!head) reasons.push("no-verified-entry");
  const valid =
    !failure && report.authorBinding.status === "valid" && report.identityEvidence.status === "complete" &&
    report.resources.status !== "digest-failure" && fork === null;
  if (valid && selected) report.validAsOf = { checkpoint: selected.entry.versionId, signers: reliedOn(prefix, histories, options.authors) };
  // P7.10: only an anchored Original's state derived from its sat can be current (P9.13).
  report.current = valid && selected === head && anchored(head) && reasons.length === 0;
  if (headChange) report.notices.push("head-changed");
  if (onBitcoin && onBitcoin.unverifiable.length > 0) report.notices.push("unverifiable-inscriptions");
  if (onBitcoin && onBitcoin.ignored.some((i) => i.reason === "waiting-for-earlier-unverifiable")) report.notices.push("publications-waiting");
  return report;
}

/** The latest verified version of `did`, if any. */
function latestOf(histories: AuthorHistory[], did: string) {
  const h = histories.find((x) => x.did === did);
  return h?.versions[h.versions.length - 1];
}

/** P7.9, P6.5, P5.18: each entry of `prefix` its signer's latest verified DID state no longer authorizes. */
function historicallyAuthorizedOnly(prefix: VerifiedEntry[], histories: AuthorHistory[], authorDid: string | null): HistoricalAuthorization[] {
  const out: HistoricalAuthorization[] = [];
  const authorDeactivated = authorDid !== null && latestOf(histories, authorDid)?.deactivated === true;
  for (const v of prefix) {
    const { role, ref } = signerOf(v.entry.state as unknown as EntryState);
    const entry = { versionId: v.entry.versionId, did: ref.did, role };
    // An editor entry is subject to the author DID's deactivation exactly as an author entry is (P5.18).
    if (authorDeactivated) {
      out.push({ ...entry, reason: "author-did-deactivated" });
      continue;
    }
    const h = histories.find((x) => x.did === ref.did);
    const latest = h?.versions[h.versions.length - 1];
    if (!h || !latest) continue; // missing identity evidence is reported as incomplete, not here
    // An editor whose DID is deactivated authorizes nothing further, even if its document still lists the key.
    if (role === "editor" && latest.deactivated) {
      out.push({ ...entry, reason: "signer-did-deactivated" });
      continue;
    }
    const signedWith = h.versions.find((x) => x.versionId === ref.versionId);
    let key: string | undefined;
    try {
      key = signedWith ? authorKey(signedWith, ref) : undefined;
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
    }
    if (typeof key !== "string" || !stillAuthorized(latest, ref, key)) out.push({ ...entry, reason: "key-not-in-latest-signer-document" });
  }
  return out;
}

/** P7.8, P7.10: the signer DIDs a result through `prefix` relies on, the author first. */
function reliedOn(prefix: VerifiedEntry[], histories: AuthorHistory[], evidence: AuthorDidEvidence[]): SignerReliance[] {
  const out: SignerReliance[] = [];
  for (const v of prefix) {
    const { role, ref } = signerOf(v.entry.state as unknown as EntryState);
    if (out.some((s) => s.did === ref.did)) continue;
    const supplied = evidence.find((e) => e.did === ref.did);
    out.push({
      did: ref.did,
      role,
      versionId: latestOf(histories, ref.did)?.versionId ?? null,
      obtainedAt: supplied?.obtainedAt ?? null,
      source: supplied?.source ?? null,
      location: supplied?.retrievedFrom ?? null,
    });
  }
  // The author signs the genesis entry, so it comes first.
  return out;
}

/**
 * Verify an Original reached through its did:webvh alias. The alias log names
 * the did:vh; the result is that Original's own verification, and only when
 * the alias is confirmed in both directions (P3.6). Otherwise there is no
 * Originals result through that did:webvh (ALIAS_NOT_CONFIRMED).
 */
export async function verifyOriginalByAlias(options: VerifyOriginalOptions & { alias: AliasEvidence }): Promise<OriginalsReport> {
  const target = await aliasTarget(options.alias, options.now);
  if (!target) throw new OriginalsError("invalid-evidence", "ALIAS_NOT_CONFIRMED", `${options.alias.did} does not name one did:vh`);
  const report = await verifyOriginal({ ...options, aliases: [options.alias, ...(options.aliases ?? [])] });
  const confirmed = report.original === target && report.aliases.some((a) => a.did === options.alias.did && a.status === "confirmed");
  if (!confirmed) {
    throw new OriginalsError("invalid-evidence", "ALIAS_NOT_CONFIRMED", `${target} does not list ${options.alias.did} as its alias`, { report });
  }
  return report;
}
