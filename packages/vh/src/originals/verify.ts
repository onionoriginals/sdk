/**
 * Fresh verification of an Original (spec section 7). The report keeps history
 * validity, author binding, identity evidence, resource availability,
 * freshness and ordering separate; `current` is true only when every part
 * passes under the selected freshness policy. No private key or network is
 * involved (P7.3).
 *
 * Freshness (P7.6, P7.8): a caller may supply other copies of the asset log
 * and the highest versionIds it has verified before, for the Original and for
 * each author DID. Copies are compared as VH-Log describes. A log shorter than
 * the retained versionId is stale; one that diverges from it, or from another
 * valid copy, is a fork. Forks stay unresolved: every branch is reported and
 * none is current, whatever its timestamps (P2.1, P6.6; owner decision Q5).
 * Only anchoring settles a fork (P9.16, plan 011 PR 9).
 */
import { OriginalsError, type ErrorCategory } from "../errors.js";
import type { JsonObject } from "../json/index.js";
import {
  resolveCopies,
  verifyLog,
  verifyLogText,
  type CopyReport,
  type LogCopy,
  type LogLimits,
  type LogVerification,
  type VerifiedEntry,
} from "../log/index.js";
import { authorKey, stillAuthorized, verifyAuthorHistory, versionNumberOf, type AuthorDidEvidence, type AuthorHistory } from "./author.js";
import { deriveDocument, originalsSpecialisation } from "./profile.js";
import { ORIGINALS_LIMITS, ORIGINALS_METHOD, resourceDigest, type AssetState, type EntryState } from "./state.js";

export interface VerifyOriginalOptions {
  /** The asset log: `did.jsonl` text or parsed entries. */
  log: string | unknown[];
  /** Author DID histories. Missing history is incomplete evidence, never trust in the key (P5.6). */
  authors: AuthorDidEvidence[];
  witnessFile?: unknown;
  /** Resource bytes by digest. */
  bytes?: Record<string, Uint8Array> | ((digest: string) => Uint8Array | undefined);
  /** Verify this exact checkpoint instead of the head (P3.2). */
  checkpoint?: string;
  /**
   * The freshness of the supplied asset log and author DID histories (P7.6,
   * P7.8). `asserted` means the caller vouches that they are the latest, as an
   * author's own SDK can; the report says so. Without it, freshness is not
   * established. A retained versionId the evidence falls short of overrides it.
   */
  freshness?: "asserted";
  /** Other copies of the asset log, compared with the supplied one (VH-Log "Comparing Copies"). */
  copies?: LogCopy[];
  /** The highest versionIds verified before, for the Original and per author DID (P7.8). */
  retained?: RetainedVersions;
  now?: number | Date;
  limits?: LogLimits & { maxAuthorVersions?: number };
}

export interface RetainedVersions {
  original?: string;
  authors?: Record<string, string>;
}

export type Freshness = "asserted" | "not-established" | "stale";

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
    /** The retained versionId for the author DID, when one was supplied. */
    retainedVersionId: string | null;
    deactivated: boolean;
    failure?: { code: string; message: string };
  };
  resources: { status: "available" | "partial" | "digest-failure"; versions: ResourceVersion[]; missing: ResourceVersion[]; failures: ResourceVersion[] };
  /** Whether the asset log is the latest, under the freshness policy and the retained versionId (P7.6). */
  assetFreshness: { status: Freshness; retainedVersionId: string | null; copies: CopyReport[] };
  fork: OriginalsFork | null;
  /** Ordering of the checkpoint: witnessed when threshold witnesses approved it, otherwise claimed only (P7.6, P9.8). */
  ordering: "claimed" | "witnessed";
  /** The entry that activated witnesses. Entries before it keep claimed ordering (P7.6). */
  witnessedFrom: string | null;
  deactivated: boolean;
  state: AssetState | null;
  /** The derived DID document at the checkpoint (P3.8). */
  document: JsonObject | null;
  current: boolean;
  /** Why the result is not current. */
  reasons: string[];
  /**
   * The versionIds to retain after this verification: never lower than those
   * supplied, and unchanged by a fork or stale evidence.
   */
  retain: { original: string | null; authors: Record<string, string> };
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

function lookup(bytes: VerifyOriginalOptions["bytes"], digest: string): Uint8Array | undefined {
  if (!bytes) return undefined;
  return typeof bytes === "function" ? bytes(digest) : (Object.prototype.hasOwnProperty.call(bytes, digest) ? bytes[digest] : undefined);
}

/** Resource versions through the prefix, with each version's bytes checked (P4.3, P4.4, P7.4). */
function resourceVersions(prefix: VerifiedEntry[], bytes: VerifyOriginalOptions["bytes"]): ResourceVersion[] {
  const out: ResourceVersion[] = [];
  const counts = new Map<string, number>();
  for (const v of prefix) {
    const state = v.entry.state as unknown as EntryState;
    for (const t of state.transitions) {
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
  const retainedAuthors = { ...options.retained?.authors };
  const staleAuthors = new Set<string>();
  const forkedAuthors = new Set<string>();
  for (const evidence of options.authors) {
    try {
      const h = await verifyAuthorHistory(evidence, { now: options.now, maxVersions: options.limits?.maxAuthorVersions });
      histories.push(h);
      if (h.failure) identityFailures.push({ code: h.failure.error.code, message: `author DID ${h.did}: ${h.failure.error.message}` });
      const retained = retainedAuthors[h.did];
      if (retained !== undefined) {
        const at = h.versions[versionNumberOf(retained) - 1];
        if (!at) staleAuthors.add(h.did);
        else if (at.versionId !== retained) {
          forkedAuthors.add(h.did);
          identityFailures.push({ code: "AUTHOR_DID_FORK", message: `author DID ${h.did} diverges from the retained version ${retained}` });
        }
      }
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
      identityFailures.push({ code: error.code, message: error.message });
    }
  }

  const verifyOptions = {
    specialisation: originalsSpecialisation(histories),
    witnessFile: options.witnessFile,
    now: options.now,
    limits: { maxEntries: ORIGINALS_LIMITS.entries, maxEntryBytes: ORIGINALS_LIMITS.entryBytes, ...options.limits },
  };
  const supplied = (): Promise<LogVerification> =>
    typeof options.log === "string" ? verifyLogText(options.log, verifyOptions) : verifyLog(options.log, verifyOptions);
  let log: LogVerification;
  let fork: OriginalsFork | null = null;
  let copies: CopyReport[] = [];
  let stale = false;
  if ((options.copies?.length ?? 0) > 0 || options.retained?.original !== undefined) {
    const text = typeof options.log === "string" ? options.log : options.log.map((e) => `${JSON.stringify(e)}\n`).join("");
    const resolution = await resolveCopies({ source: "supplied", log: text, witnessFile: options.witnessFile }, options.copies ?? [], {
      ...verifyOptions,
      ...(options.retained?.original !== undefined ? { retainedVersionId: options.retained.original } : {}),
    });
    copies = resolution.copies;
    stale = resolution.warnings.some((w) => w.code === "retained-version-not-found");
    if (resolution.fork) fork = { version: resolution.fork.version, branches: resolution.fork.copies };
    // On a fork the report describes the supplied branch, never as current.
    log = resolution.reference ?? (await supplied());
  } else {
    log = await supplied();
  }
  const failure = log.failure ? toFailure(log.failure.index, log.failure.versionId, log.failure.error) : undefined;

  const head = log.entries[log.entries.length - 1];
  const authorDid = head ? (head.entry.state as unknown as EntryState).author.did : null;
  const history = authorDid ? histories.find((h) => h.did === authorDid) : undefined;
  const latest = history?.versions[history.versions.length - 1];

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

  const bindingFailed = failure && (failure.category === "author-binding" || failure.category === "unauthorized-key");
  const identityIncomplete = failure?.category === "incomplete-evidence" || identityFailures.length > 0 || !history;
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
      freshness: authorDid && staleAuthors.has(authorDid) ? "stale" : options.freshness === "asserted" ? "asserted" : "not-established",
      retainedVersionId: (authorDid && retainedAuthors[authorDid]) || null,
      deactivated: latest?.deactivated ?? false,
      ...(identityFailures[0] ? { failure: identityFailures[0] } : {}),
    },
    resources: {
      status: mismatched.length > 0 ? "digest-failure" : missing.length > 0 ? "partial" : "available",
      versions,
      missing,
      failures: mismatched,
    },
    assetFreshness: {
      status: stale ? "stale" : options.freshness === "asserted" ? "asserted" : "not-established",
      retainedVersionId: options.retained?.original ?? null,
      copies,
    },
    fork,
    ordering: selected?.witnessed ? "witnessed" : "claimed",
    witnessedFrom: log.entries.find((v) => v.witnessList !== null)?.entry.versionId ?? null,
    deactivated: log.deactivated,
    state: state?.asset ?? null,
    document: selected ? deriveDocument(prefix) : null,
    current: false,
    reasons,
    retain: { original: retainOriginal(head?.entry.versionId, options.retained?.original, fork !== null), authors: retainedAuthors },
  };
  for (const h of histories) {
    const latestId = h.versions[h.versions.length - 1]?.versionId;
    if (latestId && !staleAuthors.has(h.did) && !forkedAuthors.has(h.did)) report.retain.authors[h.did] = latestId;
  }

  if (failure) reasons.push(`history-${report.history.status}`);
  if (report.identityEvidence.status === "incomplete") reasons.push("identity-evidence-incomplete");
  if (fork) reasons.push("fork-unresolved");
  if (report.assetFreshness.status === "stale") reasons.push("asset-log-older-than-retained");
  if (report.assetFreshness.status === "not-established") reasons.push("asset-freshness-not-established");
  if (report.identityEvidence.freshness === "stale") reasons.push("author-history-older-than-retained");
  if (report.identityEvidence.freshness === "not-established") reasons.push("author-freshness-not-established");
  if (report.identityEvidence.deactivated) reasons.push("author-did-deactivated");
  if (report.resources.status !== "available") reasons.push(`resources-${report.resources.status}`);
  if (!head) reasons.push("no-verified-entry");
  // P7.9: an unwitnessed head signed by a key the latest author DID no longer lists is never current.
  // A witnessed head was approved against the author DID's latest state at the time (P9.8).
  if (head && latest && !head.witnessed) {
    const ref = (head.entry.state as unknown as EntryState).author;
    const signedWith = history.versions.find((v) => v.versionId === ref.versionId);
    let key: string | undefined;
    try {
      key = signedWith ? authorKey(signedWith, ref) : undefined;
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
    }
    if (typeof key !== "string" || !stillAuthorized(latest, ref, key)) reasons.push("head-key-not-in-latest-author-document");
  }
  report.current = reasons.length === 0;
  return report;
}
