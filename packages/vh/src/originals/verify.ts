/**
 * Fresh verification of an Original (spec section 7). The report keeps history
 * validity, author binding, identity evidence, resource availability and
 * ordering separate; `current` is true only when every part passes under the
 * selected freshness policy. No private key or network is involved (P7.3).
 */
import { OriginalsError, type ErrorCategory } from "../errors.js";
import type { JsonObject } from "../json/index.js";
import { verifyLog, verifyLogText, type LogLimits, type LogVerification, type VerifiedEntry } from "../log/index.js";
import { authorKey, stillAuthorized, verifyAuthorHistory, type AuthorDidEvidence, type AuthorHistory } from "./author.js";
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
   * The freshness of the supplied author DID histories (P7.8). `asserted` means
   * the caller vouches that they are the latest, as an author's own SDK can;
   * the report says so. Without it, freshness is not established.
   */
  freshness?: "asserted";
  now?: number | Date;
  limits?: LogLimits & { maxAuthorVersions?: number };
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
    freshness: "asserted" | "not-established";
    deactivated: boolean;
    failure?: { code: string; message: string };
  };
  resources: { status: "available" | "partial" | "digest-failure"; versions: ResourceVersion[]; missing: ResourceVersion[]; failures: ResourceVersion[] };
  /** Unwitnessed and unanchored: claimed ordering only (P7.6). */
  ordering: "claimed";
  deactivated: boolean;
  state: AssetState | null;
  /** The derived DID document at the checkpoint (P3.8). */
  document: JsonObject | null;
  current: boolean;
  /** Why the result is not current. */
  reasons: string[];
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

export async function verifyOriginal(options: VerifyOriginalOptions): Promise<OriginalsReport> {
  const reasons: string[] = [];
  const histories: AuthorHistory[] = [];
  const identityFailures: Array<{ code: string; message: string }> = [];
  for (const evidence of options.authors) {
    try {
      const h = await verifyAuthorHistory(evidence, { now: options.now, maxVersions: options.limits?.maxAuthorVersions });
      histories.push(h);
      if (h.failure) identityFailures.push({ code: h.failure.error.code, message: `author DID ${h.did}: ${h.failure.error.message}` });
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
  const log: LogVerification = typeof options.log === "string" ? await verifyLogText(options.log, verifyOptions) : await verifyLog(options.log, verifyOptions);
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
      freshness: options.freshness === "asserted" ? "asserted" : "not-established",
      deactivated: latest?.deactivated ?? false,
      ...(identityFailures[0] ? { failure: identityFailures[0] } : {}),
    },
    resources: {
      status: mismatched.length > 0 ? "digest-failure" : missing.length > 0 ? "partial" : "available",
      versions,
      missing,
      failures: mismatched,
    },
    ordering: "claimed",
    deactivated: log.deactivated,
    state: state?.asset ?? null,
    document: selected ? deriveDocument(prefix) : null,
    current: false,
    reasons,
  };

  if (failure) reasons.push(`history-${report.history.status}`);
  if (report.identityEvidence.status === "incomplete") reasons.push("identity-evidence-incomplete");
  if (report.identityEvidence.freshness === "not-established") reasons.push("author-freshness-not-established");
  if (report.identityEvidence.deactivated) reasons.push("author-did-deactivated");
  if (report.resources.status !== "available") reasons.push(`resources-${report.resources.status}`);
  if (!head) reasons.push("no-verified-entry");
  // P7.9: an unwitnessed head signed by a key the latest author DID no longer lists is never current.
  if (head && latest) {
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
