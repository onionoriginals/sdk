/**
 * Verifying a repository (plan 049 §2). The Originals reports come from the
 * SDK unchanged; the `originals-code/0.1` checks run on top of them and are
 * reported separately, never merged into one verdict (section 7). Nothing is
 * ever reported current: every Original here is unanchored (P7.10).
 */
import { parseLog, type LogEntry } from "@originals/vh/log";
import { signerOf, type EntryState, type OriginalsReport } from "@originals/vh/originals";
import { MemoryStore, OriginalsSDK, type ZipLimits } from "@originals/sdk/originals";
import { readBundle, type BundleLimits, type BundleManifest } from "./bundle.js";
import { canonicalHead, type CanonicalResult, type DelegateHead } from "./canonical.js";
import { REPO_MEDIA_TYPE, checkBranchMetadata, checkRepoMetadata, decodeRepoDocument, type RepoDocument } from "./documents.js";
import { StructuredError } from "@originals/vh";
import { OriginalsError } from "./errors.js";
import { covers } from "./grants.js";
import { TREE_MEDIA_TYPE, diffTrees, gitCommitId, gitTreeIdOf, parseGitCommit, readTree, type ObjectSource } from "./objects.js";

export interface CodeFailure {
  index: number;
  versionId: string;
  code: string;
  message: string;
}

/** The code profile's verdict on one log, separate from its Originals report. */
export interface CodeHistory {
  /** valid · invalid (the first failing entry) · incomplete (evidence the check needs is missing). */
  status: "valid" | "invalid" | "incomplete";
  /** Entries checked: the verified Originals checkpoint's prefix. */
  entries: number;
  failure?: CodeFailure;
}

export interface RepoVersion {
  versionId: string;
  index: number;
  document: RepoDocument;
}

export interface RepoCodeReport {
  original: string;
  author: string | null;
  history: CodeHistory;
  /** The repo document at each verified entry, oldest first. */
  versions: RepoVersion[];
  /** The repo document at the checkpoint. */
  document: RepoDocument | null;
}

export interface GrantCheck {
  versionId: string;
  signer: string;
  status: "allowed" | "outside-grant" | "unchecked";
  touched: number;
  outside?: string[];
}

export interface BranchCodeReport {
  original: string;
  author: string | null;
  ref: string | null;
  history: CodeHistory;
  /**
   * Whether the branch counts for the repo, both ways: listed in the repo
   * document at its checkpoint under its author for its ref, and naming that
   * repo and ref itself (as an alias counts only both ways, P3.6).
   * `superseded`: an earlier segment of a confirmed branch (K13), reached
   * through the listed segment's chain, not listed itself.
   * `contribution` (K14, O7): a branch naming this repo and ref that the repo
   * document does not list under any delegate. Anyone may publish one; it is
   * verified like any branch and never votes for a canonical head.
   */
  binding: { status: "confirmed" | "superseded" | "contribution" | "mismatch" | "not-checked"; delegate?: string; reason?: string };
  /** Content availability, separately (P7.3, P7.4 by analogy): missing objects never fail the history. */
  content: { status: "complete" | "partial" | "digest-failure"; objects: number; bytes: number; missing: string[]; failures: string[] };
  /** git tree ids recomputed from the objects against each entry's claim. A mismatch fails the history. */
  gitBinding: { status: "matches" | "mismatch" | "unchecked"; checked: number; unchecked: number; mismatches: Array<{ versionId: string; claimed: string; computed: string }> };
  /**
   * git commit ids recomputed from the mirrored raw commit objects (K12, O3),
   * reported separately from `gitBinding`. For each commit whose entry names
   * a commit object: its SHA-1 must be the commit id, its `tree` the entry's
   * tree and its first parent the previous entry's commit; a mismatch fails
   * the history. A commit with no commit object is `claimed` by its signer
   * only; one whose object is missing is `unchecked` (never a pass).
   * Status: mismatch, else unchecked, else claimed, else matches.
   */
  commitBinding: {
    status: "matches" | "mismatch" | "unchecked" | "claimed";
    checked: number;
    unchecked: number;
    claimed: number;
    mismatches: Array<{ versionId: string; code: string; claimed: string; computed: string }>;
    /**
     * The first parent of the branch's first commit, from its commit object:
     * null for a root commit, absent when that commit is not checked. History
     * before it is not in this branch.
     */
    base?: string | null;
  };
  /** Entries by a signer other than the branch's author, checked against path grants (phase 3). */
  grants: GrantCheck[];
  /** Entries allowed by the repo version they name but not by the latest one (P7.9 by analogy). */
  historicallyAuthorizedOnly: Array<{ versionId: string; signer: string; reason: "path-grant-narrowed" }>;
  /**
   * The commits the verified entries name, oldest first, consecutive repeats
   * folded. For a later segment (K13), the whole branch's: every earlier
   * segment's chain, then this one's.
   */
  chain: Array<{ commit: string; root: string; versionId: string }>;
  /**
   * Where this Original sits in its branch's chain of segments (K13, O1):
   * index 0 is the first segment; `previous` is what its genesis names;
   * `segments` lists the branch's segments through this one, oldest first.
   */
  segment: { index: number; previous: { did: string; versionId: string } | null; segments: string[] };
}

/** The previous segment a segment's genesis names, as the caller verified it (K13). */
export type PriorSegment =
  | { status: "valid"; report: BranchCodeReport; last: LogEntry }
  | { status: "invalid" | "incomplete"; code: string; message: string };

export interface Objects {
  get: ObjectSource;
  /** Digests whose bytes were supplied and did not match. */
  failed?: ReadonlySet<string>;
}

const stateOf = (e: LogEntry) => e.state as unknown as EntryState;

class Stop extends Error {
  constructor(
    readonly status: "invalid" | "incomplete",
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function historyOf(entries: number, run: () => Promise<void>): Promise<CodeHistory> {
  try {
    await run();
    return { status: "valid", entries };
  } catch (thrown) {
    let e = thrown;
    let index = -1;
    let versionId = "";
    if (e instanceof Located) {
      index = e.index;
      versionId = e.versionId;
      e = e.cause;
    }
    if (e instanceof Stop) return { status: e.status, entries, failure: { index, versionId, code: e.code, message: e.message } };
    if (e instanceof OriginalsError) {
      const status = e.category === "unavailable-bytes" || e.category === "incomplete-evidence" ? "incomplete" : "invalid";
      return { status, entries, failure: { index, versionId, code: e.code, message: e.message } };
    }
    throw e;
  }
}

class Located extends Error {
  constructor(
    readonly index: number,
    readonly versionId: string,
    override readonly cause: unknown,
  ) {
    super("located");
  }
}

async function each(entries: readonly LogEntry[], f: (e: LogEntry, i: number) => void | Promise<void>): Promise<void> {
  for (let i = 0; i < entries.length; i++) {
    try {
      await f(entries[i], i);
    } catch (e) {
      throw new Located(i, entries[i].versionId, e);
    }
  }
}

/** The repo Original's code checks (K5) over its verified entries. */
export async function checkRepo(original: string, entries: readonly LogEntry[], resources: ObjectSource): Promise<RepoCodeReport> {
  const versions: RepoVersion[] = [];
  const author = entries.length > 0 ? stateOf(entries[0]).author.did : null;
  const history = await historyOf(entries.length, () =>
    each(entries, async (e, i) => {
      const s = stateOf(e);
      checkRepoMetadata(s.asset.metadata);
      if (s.asset.resource.mediaType !== REPO_MEDIA_TYPE) throw new Stop("invalid", "REPO_RESOURCE", `the repo Original's resource is ${REPO_MEDIA_TYPE}`);
      const bytes = await resources(s.asset.resource.digest);
      if (!bytes) throw new Stop("incomplete", "REPO_DOCUMENT_MISSING", `the repo document ${s.asset.resource.digest} is not in the evidence`);
      const document = decodeRepoDocument(bytes);
      // K5: the repo's author is a delegate at every version.
      if (!document.delegates.includes(s.author.did)) throw new Stop("invalid", "REPO_AUTHOR", "the repo Original's author must be one of its delegates");
      versions.push({ versionId: e.versionId, index: i, document });
    }),
  );
  return { original, author, history, versions, document: history.status === "valid" && versions.length > 0 ? versions[versions.length - 1].document : null };
}

/** A branch Original's code checks (K4, K7) over its verified entries. */
export async function checkBranch(
  original: string,
  entries: readonly LogEntry[],
  context: { repo: string; versions: readonly RepoVersion[]; latest: RepoDocument | null; objects: Objects; gitMemo?: Map<string, string>; prior?: PriorSegment },
): Promise<BranchCodeReport> {
  const author = entries.length > 0 ? stateOf(entries[0]).author.did : null;
  const byId = new Map(context.versions.map((v) => [v.versionId, v]));
  const get = context.objects.get;
  const failedSet = context.objects.failed ?? new Set<string>();
  const memo = context.gitMemo ?? new Map<string, string>();
  const report: BranchCodeReport = {
    original,
    author,
    ref: null,
    history: { status: "valid", entries: entries.length },
    binding: { status: "not-checked" },
    content: { status: "complete", objects: 0, bytes: 0, missing: [], failures: [] },
    gitBinding: { status: "matches", checked: 0, unchecked: 0, mismatches: [] },
    commitBinding: { status: "matches", checked: 0, unchecked: 0, claimed: 0, mismatches: [] },
    grants: [],
    historicallyAuthorizedOnly: [],
    chain: [],
    segment: { index: 0, previous: null, segments: [original] },
  };
  const prior = context.prior?.status === "valid" ? context.prior : undefined;
  if (prior) {
    report.chain = [...prior.report.chain];
    report.segment = { index: prior.report.segment.index + 1, previous: null, segments: [...prior.report.segment.segments, original] };
    if (prior.report.commitBinding.base !== undefined) report.commitBinding.base = prior.report.commitBinding.base;
  }

  // Content: every object reachable from every verified version, each once.
  const seen = new Set<string>();
  const brokenTrees = new Set<string>();
  async function reach(digest: string, tree: boolean): Promise<void> {
    if (seen.has(digest)) return;
    seen.add(digest);
    if (failedSet.has(digest)) {
      report.content.failures.push(digest);
      return;
    }
    const bytes = await get(digest);
    if (!bytes) {
      report.content.missing.push(digest);
      return;
    }
    report.content.objects++;
    report.content.bytes += bytes.length;
    if (!tree) return;
    let entriesOf;
    try {
      entriesOf = (await readTree(digest, () => bytes)).entries;
    } catch {
      brokenTrees.add(digest);
      return;
    }
    for (const child of Object.values(entriesOf)) await reach(child.digest, child.mode === "40000");
  }

  // K12: the commit id, tree and first parent recomputed from the raw commit object.
  const cb = report.commitBinding;
  async function checkCommitObject(versionId: string, m: { commit: string; tree: string; commitObject?: string }, before: string | undefined): Promise<void> {
    if (!m.commitObject) {
      cb.claimed++;
      return;
    }
    await reach(m.commitObject, false);
    const bytes = failedSet.has(m.commitObject) ? undefined : await get(m.commitObject);
    if (!bytes) {
      cb.unchecked++;
      return;
    }
    const mismatch = (code: string, claimed: string, computed: string, message: string): never => {
      cb.mismatches.push({ versionId, code, claimed, computed });
      throw new Stop("invalid", code, message);
    };
    const id = gitCommitId(bytes);
    if (id !== m.commit) mismatch("GIT_COMMIT_MISMATCH", m.commit, id, `the entry claims commit ${m.commit}; its commit object hashes to ${id}`);
    const header = parseGitCommit(bytes);
    if (header.tree !== m.tree) mismatch("COMMIT_TREE_MISMATCH", m.tree, header.tree, `commit ${m.commit} names tree ${header.tree}, the entry ${m.tree}`);
    const first = header.parents[0] ?? null;
    if (before === undefined) cb.base = first;
    else if (first !== before) mismatch("COMMIT_PARENT_MISMATCH", before, first ?? "none", `commit ${m.commit}'s first parent is ${first ?? "none"}, not the previous entry's commit ${before}`);
    cb.checked++;
  }

  let ref: string | null = prior ? prior.report.ref : null;
  let previousRepoIndex = -1;
  if (prior) {
    const v = byId.get(checkBranchMetadata(stateOf(prior.last).asset.metadata).repoVersion);
    previousRepoIndex = v ? v.index : -1;
  }
  const seenCommits = new Set<string>(report.chain.map((c) => c.commit));
  report.history = await historyOf(entries.length, () =>
    each(entries, async (e, i) => {
      const s = stateOf(e);
      const m = checkBranchMetadata(s.asset.metadata);
      if (m.repo !== context.repo) throw new Stop("invalid", "BRANCH_REPO", `the entry names repo ${m.repo}, not ${context.repo}`);
      // K13: a later segment's genesis names the previous segment, which must verify and end at the named entry.
      if (m.previous && i > 0) throw new Stop("invalid", "SEGMENT_PREVIOUS_LATE", "only a segment's genesis names the previous segment (K13)");
      if (i === 0 && m.previous) {
        const p = context.prior;
        if (!p) throw new Stop("incomplete", "SEGMENT_PREVIOUS_MISSING", `the previous segment ${m.previous.did} is not in the evidence`);
        if (p.status !== "valid") throw new Stop(p.status, p.code, p.message);
        if (p.last.state.id !== m.previous.did || p.last.versionId !== m.previous.versionId) throw new Stop("invalid", "SEGMENT_PREVIOUS", "the previous segment does not end at the entry this genesis names");
        if (stateOf(p.last).author.did !== author) throw new Stop("invalid", "SEGMENT_AUTHOR", "every segment of a branch has the same author (P5.8, K13)");
        report.segment.previous = { did: m.previous.did, versionId: m.previous.versionId };
      }
      if (i === 0 && !prior) ref = m.ref;
      if (m.ref !== ref || s.asset.name !== m.ref) throw new Stop("invalid", "BRANCH_REF", "a branch Original's name and ref are its ref, at every entry");
      if (s.asset.resource.mediaType !== TREE_MEDIA_TYPE) throw new Stop("invalid", "BRANCH_RESOURCE", `a branch Original's resource is ${TREE_MEDIA_TYPE}`);
      const root = s.asset.resource.digest;

      const version = byId.get(m.repoVersion);
      if (!version) throw new Stop("incomplete", "REPO_VERSION_UNKNOWN", `repo version ${m.repoVersion} is not in the verified repo evidence`);
      if (version.index < previousRepoIndex) throw new Stop("invalid", "REPO_VERSION_BACKWARDS", "repoVersion never goes backwards within a branch (as P5.8 for signer versions)");
      previousRepoIndex = version.index;

      // At a later segment's genesis, the parent state is the previous segment's last entry.
      const previous = i > 0 ? stateOf(entries[i - 1]) : prior ? stateOf(prior.last) : undefined;
      const previousCommit = i > 0 ? (previous!.asset.metadata as { code: { commit: string } }).code.commit : undefined;
      if (previousCommit === m.commit) {
        if (previous!.asset.resource.digest !== root) throw new Stop("invalid", "BRANCH_COMMIT_CHANGED", "an entry repeating its parent's commit keeps its tree");
        const previousObject = (previous!.asset.metadata as { code: { commitObject?: string } }).code.commitObject;
        if (previousObject !== m.commitObject) throw new Stop("invalid", "BRANCH_COMMIT_CHANGED", "an entry repeating its parent's commit keeps its commit object (K12)");
      } else {
        if (seenCommits.has(m.commit)) throw new Stop("invalid", "BRANCH_COMMIT_REPEATED", `commit ${m.commit} appears twice in one first-parent chain`);
        seenCommits.add(m.commit);
        const before = report.chain.length > 0 ? report.chain[report.chain.length - 1].commit : undefined;
        await checkCommitObject(e.versionId, m, before);
        report.chain.push({ commit: m.commit, root, versionId: e.versionId });
      }

      // Content and the git tree claim.
      await reach(root, true);
      if (brokenTrees.size > 0) throw new Stop("invalid", "TREE_FORMAT", `tree ${[...brokenTrees][0]} is not a valid ${TREE_MEDIA_TYPE} object`);
      let computed: string | undefined;
      try {
        computed = await gitTreeIdOf(root, async (d) => (failedSet.has(d) ? undefined : get(d)), memo);
      } catch (err) {
        if (!(err instanceof OriginalsError && err.code === "OBJECT_MISSING")) throw err;
      }
      if (computed === undefined) report.gitBinding.unchecked++;
      else if (computed !== m.tree) {
        report.gitBinding.mismatches.push({ versionId: e.versionId, claimed: m.tree, computed });
        throw new Stop("invalid", "GIT_TREE_MISMATCH", `the entry claims git tree ${m.tree}; its objects give ${computed}`);
      } else report.gitBinding.checked++;

      // Path grants: an entry by anyone but the branch's author (phase 3, K7).
      const signer = signerOf(s).ref.did;
      if (signer !== author) {
        const grant = version.document.grants.find((g) => g.did === signer);
        let touched: string[];
        try {
          touched = await diffTrees(previous ? previous.asset.resource.digest : null, root, get);
        } catch (err) {
          if (err instanceof OriginalsError && err.code === "OBJECT_MISSING") {
            report.grants.push({ versionId: e.versionId, signer, status: "unchecked", touched: 0 });
            throw new Stop("incomplete", "GRANT_UNCHECKED", "a tree the path-grant check needs is missing");
          }
          throw err;
        }
        if (!grant && touched.length > 0) {
          report.grants.push({ versionId: e.versionId, signer, status: "outside-grant", touched: touched.length, outside: touched });
          throw new Stop("invalid", "NO_PATH_GRANT", `${signer} has no path grant in repo version ${m.repoVersion}`);
        }
        const outside = grant ? covers(grant.paths, touched) : [];
        if (outside.length > 0) {
          report.grants.push({ versionId: e.versionId, signer, status: "outside-grant", touched: touched.length, outside });
          throw new Stop("invalid", "OUTSIDE_PATH_GRANT", `${signer} changed ${outside.length} path(s) outside its grant: ${outside.slice(0, 5).join(", ")}`);
        }
        report.grants.push({ versionId: e.versionId, signer, status: "allowed", touched: touched.length });
        const latestGrant = context.latest?.grants.find((g) => g.did === signer);
        if (touched.length > 0 && (!latestGrant || covers(latestGrant.paths, touched).length > 0)) {
          report.historicallyAuthorizedOnly.push({ versionId: e.versionId, signer, reason: "path-grant-narrowed" });
        }
      }
    }),
  );
  const finalRef = ref;
  report.ref = finalRef;
  if (report.content.failures.length > 0) report.content.status = "digest-failure";
  else if (report.content.missing.length > 0) report.content.status = "partial";
  report.gitBinding.status = report.gitBinding.mismatches.length > 0 ? "mismatch" : report.gitBinding.unchecked > 0 ? "unchecked" : "matches";
  cb.status = cb.mismatches.length > 0 ? "mismatch" : cb.unchecked > 0 ? "unchecked" : cb.claimed > 0 ? "claimed" : "matches";

  // Binding both ways against the repo document at its checkpoint.
  if (context.latest && finalRef && author) {
    const listed = Object.entries(context.latest.refs).flatMap(([r, rule]) => Object.entries(rule.branches).filter(([, b]) => b === original).map(([d]) => ({ ref: r, delegate: d })));
    if (listed.length === 0) report.binding = { status: "contribution" };
    else if (listed[0].ref !== finalRef) report.binding = { status: "mismatch", delegate: listed[0].delegate, reason: `listed for ${listed[0].ref}, names ${finalRef}` };
    else if (listed[0].delegate !== author) report.binding = { status: "mismatch", delegate: listed[0].delegate, reason: `listed under ${listed[0].delegate}, authored by ${author}` };
    else report.binding = { status: "confirmed", delegate: author };
  }
  return report;
}

export interface OriginalResult {
  original: string;
  /** The SDK's report, unchanged (`originals:1.0`). */
  report: OriginalsReport | null;
  /** Why there is no report, or the import refusal. */
  error?: { category: string; code: string; message: string };
  /** Each package of this Original in the bundle, as `sdk.load` judged it on its own. */
  packages: Array<{ file: string; checkpoint: string; history: string; validAsOf: string | null; import?: string }>;
}

export interface RepositoryReport {
  profile: "originals-code/0.1";
  manifest: BundleManifest;
  repo: OriginalResult & { code: RepoCodeReport | null };
  branches: Array<OriginalResult & { code: BranchCodeReport | null }>;
  /**
   * computed: one result per ref of the repo document at its checkpoint.
   * incomplete: evidence for the repo Original or its document is missing.
   * invalid: the repo Original or its document fails. In both, no ref has a
   * result; never read an empty list as agreement (section 7).
   */
  canonicalStatus: "computed" | "incomplete" | "invalid";
  canonical: CanonicalResult[];
  /**
   * Contributor branches (K14, plan 049 O7): branches naming this repo that
   * the repo document does not list. Each is verified (its Originals report
   * and code history, in `branches`) and never votes for a canonical head.
   */
  contributions: Contribution[];
  /** Each Original the results rely on, as of its checkpoint. Never current: nothing here is anchored (P7.10). */
  validAsOf: { repo: string | null; branches: Array<{ original: string; checkpoint: string }> };
  current: false;
}

export interface Contribution {
  /** The contribution's newest segment. */
  original: string;
  author: string | null;
  ref: string | null;
  /** valid: both reports valid; head is its last commit. Never a vote. */
  status: "valid" | "invalid" | "incomplete" | "forked";
  head: string | null;
  segments: number;
}

export interface VerifyRepositoryOptions {
  /** Verification time (ms since the epoch or a Date); now by default. */
  now?: number | Date;
  limits?: BundleLimits & { packages?: ZipLimits };
}

function errorOf(e: unknown): { category: string; code: string; message: string } {
  if (e instanceof OriginalsError) return { category: e.category, code: e.code, message: e.message };
  if (e instanceof StructuredError) return { category: "invalid-evidence", code: e.code, message: e.message };
  throw e;
}

function repoIncomplete(report: OriginalsReport | null, code: RepoCodeReport | null): boolean {
  if (!report || report.history.status === "incomplete" || report.identityEvidence.status === "incomplete") return true;
  if (report.history.status !== "valid" || report.authorBinding.status === "failed" || report.fork) return false;
  return !code || code.history.status === "incomplete";
}

function entriesThrough(log: string, checkpoint: string | null): LogEntry[] {
  if (!checkpoint) return [];
  const all = parseLog(log) as unknown as LogEntry[];
  const at = all.findIndex((e) => e.versionId === checkpoint);
  return at < 0 ? [] : all.slice(0, at + 1);
}

/** A verified bundle, opened for reading (the repository viewer). */
export interface OpenedRepository {
  report: RepositoryReport;
  /** Each Original's entries through its verified checkpoint, oldest first; absent when there is none. */
  entries: Map<string, LogEntry[]>;
  /** Every object the bundle carries: root trees, trees, blobs and the repo documents. */
  objects: ObjectSource;
}

/**
 * Verify a repo bundle offline, with no key and no network (P7.3): each
 * Original through the SDK, unchanged, then the code checks and the
 * canonical heads, each reported separately.
 */
export async function verifyRepository(bundle: Uint8Array, options: VerifyRepositoryOptions = {}): Promise<RepositoryReport> {
  return (await openRepository(bundle, options)).report;
}

/**
 * {@link verifyRepository}, also returning the verified entries and the
 * objects, so a reader shows only what the report vouches for.
 */
export async function openRepository(bundle: Uint8Array, options: VerifyRepositoryOptions = {}): Promise<OpenedRepository> {
  const contents = await readBundle(bundle, options.limits);
  const now = options.now === undefined ? undefined : typeof options.now === "number" ? options.now : options.now.getTime();
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: [], ...(now !== undefined ? { clock: () => now } : {}), ...(options.limits?.packages ? { archiveLimits: options.limits.packages } : {}) });

  const results = new Map<string, OriginalResult>();
  for (const p of contents.packages) {
    const result = results.get(p.original) ?? { original: p.original, report: null, packages: [] };
    results.set(p.original, result);
    const row: OriginalResult["packages"][number] = { file: p.file, checkpoint: p.checkpoint, history: "unread", validAsOf: null };
    result.packages.push(row);
    try {
      const loaded = await sdk.load(p.bytes);
      row.history = loaded.report.history.status;
      row.validAsOf = loaded.report.validAsOf?.checkpoint ?? null;
      if (loaded.report.original !== p.original) {
        result.error = { category: "invalid-evidence", code: "BUNDLE_ORIGINAL", message: `${p.file} is evidence for ${loaded.report.original}, not ${p.original}` };
        continue;
      }
      if (!result.report) result.report = loaded.report;
      row.import = (await sdk.import(p.bytes, { original: p.original })).status;
    } catch (e) {
      result.error ??= errorOf(e);
    }
  }
  // The stored view: with every copy imported, a divergence is reported as a fork (P6.6, P9.16).
  for (const r of results.values()) {
    if (!(await store.get(r.original))) continue;
    try {
      r.report = (await sdk.get(r.original)).report;
    } catch (e) {
      r.error ??= errorOf(e);
    }
  }

  const resources: ObjectSource = (d) => store.getResource(d);
  const objects: Objects = {
    get: async (d) => contents.objects.get(d) ?? (await store.getResource(d)),
    failed: contents.failed,
  };
  const logOf = async (did: string) => (await store.get(did))?.log;

  const repoResult = results.get(contents.manifest.repo) ?? { original: contents.manifest.repo, report: null, packages: [], error: { category: "incomplete-evidence", code: "REPO_MISSING", message: "the bundle carries no evidence for its repo Original" } };
  let repoCode: RepoCodeReport | null = null;
  const verified = new Map<string, LogEntry[]>();
  const repoLog = await logOf(contents.manifest.repo);
  if (repoResult.report?.checkpoint && repoLog) {
    const entries = entriesThrough(repoLog, repoResult.report.checkpoint);
    verified.set(contents.manifest.repo, entries);
    repoCode = await checkRepo(contents.manifest.repo, entries, resources);
  }
  const repoUsable = repoResult.report?.validAsOf != null && repoCode?.history.status === "valid";

  const gitMemo = new Map<string, string>();
  const codes = new Map<string, BranchCodeReport | null>();
  const branchEntries = new Map<string, LogEntry[]>();
  for (const r of results.values()) {
    if (r.original === contents.manifest.repo) continue;
    const log = await logOf(r.original);
    const entries = r.report?.checkpoint && log ? entriesThrough(log, r.report.checkpoint) : [];
    if (entries.length) verified.set(r.original, entries);
    branchEntries.set(r.original, entries);
  }
  const previousOf = (entries: readonly LogEntry[]) => {
    try {
      return entries.length ? checkBranchMetadata(stateOf(entries[0]).asset.metadata).previous : undefined;
    } catch {
      return undefined;
    }
  };
  // K13: a segment is checked after the segment its genesis names, continuing that one's chain.
  const codeOf = async (did: string, path: Set<string>): Promise<BranchCodeReport | null> => {
    if (codes.has(did)) return codes.get(did)!;
    const entries = branchEntries.get(did) ?? [];
    if (!entries.length || !repoCode) {
      codes.set(did, null);
      return null;
    }
    const named = previousOf(entries);
    let prior: PriorSegment | undefined;
    if (named) {
      const pr = results.get(named.did);
      const pEntries = branchEntries.get(named.did) ?? [];
      if (path.has(named.did) || named.did === did) prior = { status: "invalid", code: "SEGMENT_CYCLE", message: "segments name each other in a cycle" };
      else if (!pr || !pr.report) prior = { status: "incomplete", code: "SEGMENT_PREVIOUS_MISSING", message: `the previous segment ${named.did} is not in the evidence` };
      else if (pr.report.fork) prior = { status: "invalid", code: "SEGMENT_PREVIOUS_INVALID", message: `the previous segment ${named.did} is forked (P9.16)` };
      else if (pr.report.history.status === "incomplete" || pr.report.identityEvidence.status === "incomplete") prior = { status: "incomplete", code: "SEGMENT_PREVIOUS_INCOMPLETE", message: `the previous segment ${named.did} is incomplete` };
      else if (!pr.report.validAsOf || !pEntries.length) prior = { status: "invalid", code: "SEGMENT_PREVIOUS_INVALID", message: `the previous segment ${named.did} is not a valid Original` };
      else {
        const pc = await codeOf(named.did, new Set([...path, did]));
        const last = pEntries[pEntries.length - 1];
        const at = pEntries.findIndex((e) => e.versionId === named.versionId);
        if (!pc || pc.history.status === "incomplete") prior = { status: "incomplete", code: "SEGMENT_PREVIOUS_INCOMPLETE", message: `the previous segment ${named.did}'s code history is incomplete` };
        else if (pc.history.status !== "valid") prior = { status: "invalid", code: "SEGMENT_PREVIOUS_INVALID", message: `the previous segment ${named.did}'s code history is invalid` };
        else if (at < 0) prior = { status: "incomplete", code: "SEGMENT_PREVIOUS_VERSION", message: `${named.versionId} is not in the previous segment's verified evidence` };
        else if (last.versionId !== named.versionId) prior = { status: "invalid", code: "SEGMENT_CONTINUED", message: `the previous segment ${named.did} continues after ${named.versionId}, the entry this segment names` };
        else prior = { status: "valid", report: pc, last };
      }
    }
    const code = await checkBranch(did, entries, { repo: contents.manifest.repo, versions: repoCode.versions, latest: repoCode.document, objects, gitMemo, ...(prior ? { prior } : {}) });
    codes.set(did, code);
    return code;
  };
  const branches: RepositoryReport["branches"] = [];
  for (const r of results.values()) {
    if (r.original === contents.manifest.repo) continue;
    branches.push({ ...r, code: await codeOf(r.original, new Set()) });
  }
  // Earlier segments of a branch are reached through its newest segment, not listed (K13).
  const named = new Set<string>();
  for (const b of branches) for (const seg of b.code?.segment.segments.slice(0, -1) ?? []) named.add(seg);
  for (const b of branches) {
    const status = b.code?.binding.status;
    if (status !== "confirmed" && status !== "contribution") continue;
    if (status === "contribution" && named.has(b.original)) continue;
    for (const seg of b.code!.segment.segments.slice(0, -1)) {
      const c = codes.get(seg);
      if (c && c.binding.status === "contribution") c.binding = status === "confirmed" ? { status: "superseded", delegate: b.code!.binding.delegate! } : { status: "superseded" };
    }
  }
  // K14, O7: contributions, verified and reported on their own; they never vote.
  const contributions: Contribution[] = [];
  for (const b of branches) {
    if (b.code?.binding.status !== "contribution") continue;
    const c = b.code;
    const status: Contribution["status"] = b.report?.fork ? "forked" : !b.report?.validAsOf ? "invalid" : c.history.status;
    contributions.push({
      original: b.original,
      author: c.author,
      ref: c.ref,
      status,
      head: status === "valid" && c.chain.length ? c.chain[c.chain.length - 1].commit : null,
      segments: c.segment.segments.length,
    });
  }

  const canonical: CanonicalResult[] = [];
  if (repoUsable && repoCode?.document) {
    for (const [ref, rule] of Object.entries(repoCode.document.refs)) {
      const heads: DelegateHead[] = Object.entries(rule.branches).map(([delegate, branch]) => {
        const b = branches.find((x) => x.original === branch);
        if (!b || !b.report) return { delegate, branch, status: "missing" };
        if (b.report.fork) return { delegate, branch, status: "forked" };
        if (b.report.history.status === "incomplete" || b.report.identityEvidence.status === "incomplete") return { delegate, branch, status: "incomplete" };
        if (!b.report.validAsOf || !b.code) return { delegate, branch, status: "invalid" };
        if (b.code.history.status === "incomplete") return { delegate, branch, status: "incomplete" };
        if (b.code.history.status !== "valid" || b.code.binding.status !== "confirmed" || b.code.ref !== ref) return { delegate, branch, status: "invalid" };
        return { delegate, branch, status: "valid", chain: b.code.chain };
      });
      canonical.push(canonicalHead(ref, rule.threshold, heads));
    }
  }

  const report: RepositoryReport = {
    profile: "originals-code/0.1",
    manifest: contents.manifest,
    repo: { ...repoResult, code: repoCode },
    branches,
    canonicalStatus: repoUsable && repoCode?.document ? "computed" : repoIncomplete(repoResult.report, repoCode) ? "incomplete" : "invalid",
    canonical,
    contributions,
    validAsOf: {
      repo: repoUsable ? repoResult.report!.validAsOf!.checkpoint : null,
      branches: branches.filter((b) => b.report?.validAsOf && b.code?.history.status === "valid").map((b) => ({ original: b.original, checkpoint: b.report!.validAsOf!.checkpoint })),
    },
    current: false,
  };
  return { report, entries: verified, objects: objects.get };
}
