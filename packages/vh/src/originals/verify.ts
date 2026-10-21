/**
 * Fresh verification of an Original (spec section 7). The report keeps history
 * validity, author binding, identity evidence, resource availability,
 * freshness and ordering separate; `current` is true only when every part
 * passes under the selected freshness policy, except content availability:
 * missing resource bytes are reported as unavailable content and never fail
 * the log (P7.3, P7.4, P9.18). No private key or network is involved (P7.3).
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
import { checkAlias, aliasTarget, type AliasEvidence, type AliasReport } from "./alias.js";
import { authorKey, signerLocation, stillAuthorized, verifyAuthorHistory, versionNumberOf, type AuthorDidEvidence, type AuthorHistory } from "./author.js";
import { didWebvhLogUrl } from "../webvh/index.js";
import { deriveDocument, originalsSpecialisation } from "./profile.js";
import { ORIGINALS_LIMITS, ORIGINALS_METHOD, resourceDigest, signerOf, type AssetState, type EntryState } from "./state.js";

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
  /** did:webvh alias logs, to confirm the aliases the asset state lists (P3.6). */
  aliases?: AliasEvidence[];
  now?: number | Date;
  limits?: LogLimits & { maxAuthorVersions?: number };
}

export interface RetainedVersions {
  original?: string;
  authors?: Record<string, string>;
}

/**
 * asserted: the caller vouches for the evidence. retrieved (PROVISIONAL,
 * P5.14): an identity's log was retrieved, without redirects, from where the
 * latest entry it signed says the DID is. not-established: neither. stale:
 * shorter than a retained versionId. Only `asserted` and `retrieved` are
 * established freshness (P7.8).
 */
export type Freshness = "asserted" | "retrieved" | "not-established" | "stale";

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
  /** Whether the asset log is the latest, under the freshness policy and the retained versionId (P7.6). */
  assetFreshness: { status: Freshness; retainedVersionId: string | null; copies: CopyReport[] };
  fork: OriginalsFork | null;
  /**
   * Each alias the checkpoint's state lists, and whether it is confirmed in both
   * directions (P3.6). An unconfirmed alias does not affect the Original itself.
   */
  aliases: AliasReport[];
  /** Unwitnessed and unanchored: claimed ordering only (P7.6). */
  ordering: "claimed";
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

/**
 * P5.14: whether the identity's log was retrieved from the location of the DID
 * in the verification method id of the latest verified entry that identity
 * signed. A log found anywhere else (an old location, a redirect target, a
 * host's claim) establishes nothing.
 */
function retrievedAtLocation(did: string, role: "author" | "editor", authors: AuthorDidEvidence[], entries: VerifiedEntry[]): boolean {
  const evidence = authors.find((a) => a.did === did);
  if (!evidence?.retrievedFrom) return false;
  for (let i = entries.length - 1; i >= 0; i--) {
    // An editor entry carries its parent's author reference, so it says nothing about where a
    // moved author DID now is (P5.14): only entries the identity itself signed count.
    const signer = signerOf(entries[i].entry.state as unknown as EntryState);
    if (signer.role !== role || signer.ref.did !== did) continue;
    const ref = signer.ref;
    try {
      return didWebvhLogUrl(signerLocation(ref)) === evidence.retrievedFrom;
    } catch (error) {
      if (error instanceof OriginalsError) return false; // not a did:webvh: it has no location to retrieve from
      throw error;
    }
  }
  return false;
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
  const failuresByDid = new Map<string, { code: string; message: string }>();
  const noteFailure = (did: string, failure: { code: string; message: string }) => {
    identityFailures.push(failure);
    if (!failuresByDid.has(did)) failuresByDid.set(did, failure);
  };
  const retainedAuthors = { ...options.retained?.authors };
  const staleAuthors = new Set<string>();
  const forkedAuthors = new Set<string>();
  for (const evidence of options.authors) {
    try {
      const h = await verifyAuthorHistory(evidence, { now: options.now, maxVersions: options.limits?.maxAuthorVersions });
      histories.push(h);
      if (h.failure) noteFailure(h.did, { code: h.failure.error.code, message: `DID ${h.did}: ${h.failure.error.message}` });
      const retained = retainedAuthors[h.did];
      if (retained !== undefined) {
        const at = h.versions[versionNumberOf(retained) - 1];
        if (!at) staleAuthors.add(h.did);
        else if (at.versionId !== retained) {
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
  const authorDid = head ? (head.entry.state as unknown as EntryState).author.did : null;
  const history = authorDid ? histories.find((h) => h.did === authorDid) : undefined;
  const latest = history?.versions[history.versions.length - 1];
  const signerFreshness = (did: string | null, role: "author" | "editor"): Freshness => {
    if (did && staleAuthors.has(did)) return "stale";
    if (options.freshness === "asserted") return "asserted";
    return did && retrievedAtLocation(did, role, options.authors, log.entries) ? "retrieved" : "not-established";
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
      freshness: signerFreshness(did, "editor"),
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
  const identityIncomplete = failure?.category === "incomplete-evidence" || identityFailures.length > 0 || !history || editors.some((e) => e.status === "incomplete");
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
      freshness: signerFreshness(authorDid, "author"),
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
      status: stale ? "stale" : options.freshness === "asserted" ? "asserted" : "not-established",
      retainedVersionId: options.retained?.original ?? null,
      copies,
    },
    fork,
    aliases: await Promise.all((state?.asset.aliases ?? []).map((did) => checkAlias(`did:vh:${log.scid}`, options.aliases?.find((a) => a.did === did), did, options.now))),
    ordering: "claimed",
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
  if (editors.some((e) => e.freshness === "stale")) reasons.push("editor-history-older-than-retained");
  if (editors.some((e) => e.freshness === "not-established")) reasons.push("editor-freshness-not-established");
  // P6.5, P5.18: once the author DID is deactivated, no entry, author's or editor's, is current.
  if (report.identityEvidence.deactivated) reasons.push("author-did-deactivated");
  // P7.3, P7.4, P9.18: the log verifies without resource bytes. Missing bytes are reported in
  // `resources` as unavailable content, never as a failure, and do not affect `current`
  // (section 7: the default acceptance check excludes content availability). Bytes that are
  // supplied are still checked, and a mismatch fails.
  if (report.resources.status === "digest-failure") reasons.push("resources-digest-failure");
  if (!head) reasons.push("no-verified-entry");
  // P7.9, P5.18: an unanchored head signed by a key the latest state of its signer's DID (the
  // author's, or the editor's for an editor entry) no longer lists is never current.
  if (head) {
    const { role, ref } = signerOf(head.entry.state as unknown as EntryState);
    const signerHistory = histories.find((h) => h.did === ref.did);
    const signerLatest = signerHistory?.versions[signerHistory.versions.length - 1];
    if (signerHistory && signerLatest) {
      const signedWith = signerHistory.versions.find((v) => v.versionId === ref.versionId);
      let key: string | undefined;
      try {
        key = signedWith ? authorKey(signedWith, ref) : undefined;
      } catch (error) {
        if (!(error instanceof OriginalsError)) throw error;
      }
      if (typeof key !== "string" || !stillAuthorized(signerLatest, ref, key)) {
        reasons.push(role === "author" ? "head-key-not-in-latest-author-document" : "head-key-not-in-latest-signer-document");
      }
      // P5.18, P6.5, P7.9: an editor whose DID is deactivated authorizes nothing further, so its
      // entry at the head is not current, even if the deactivated document still lists the key.
      if (role === "editor" && signerLatest.deactivated) reasons.push("editor-did-deactivated");
    }
  }
  report.current = reasons.length === 0;
  return report;
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
