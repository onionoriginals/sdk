/**
 * The repo document and branch metadata of `originals-code/0.2` (plan 049
 * §1.2, §1.3, revised for plan 050 §5 step 3). Every member name and rule here
 * is PROVISIONAL (K4, K5): the code profile is layered on `originals:1.0` and
 * changes none of its rules. Profile 0.1 is not read: nothing was published
 * under it, so there is no migration (as plan 011 dropped earlier formats).
 *
 * In 0.2 the core carries what 0.1 kept in the document: the repo Original is
 * a set Original whose `authors` are the delegates (P5.19–P5.23), path grants
 * are `paths`-scoped grants in its `editors` (P5.28, P5.29), and each branch
 * Original is a child of the repo that pins a repo version in every entry
 * (P5.24–P5.27), replacing `metadata.code.repoVersion`.
 */
import { canonicalize, isJsonObject, parseJson, type JsonObject } from "@originals/vh/json";
import { checkDigest } from "@originals/vh/originals";
import { codeError } from "./errors.js";

/** PROVISIONAL (K1): the code profile, layered on `originals:1.0`. */
export const CODE_PROFILE = "originals-code/0.2";
/** PROVISIONAL (K5): the repo document format. */
export const REPO_FORMAT = "originals-code-repo/0.2";
/** PROVISIONAL (K3): the repo document's media type, the repo Original's resource. */
export const REPO_MEDIA_TYPE = "application/vnd.originals.code-repo+json";

export interface RefRule {
  /** How many delegates must agree on a commit for it to be the canonical head (1 ≤ threshold ≤ delegates). */
  threshold: number;
  /** Each delegate's branch Original for this ref: delegate DID → branch did:vh. */
  branches: Record<string, string>;
}

/**
 * A path grant (K7, revised): an editor grant in the repo Original's
 * `editors` with a `paths` scope (P5.28, P14.23), inherited by every branch
 * (P5.24). Derived from the repo state; not a member of the repo document.
 */
export interface PathGrant {
  did: string;
  paths: string[];
}

export interface RepoDocument {
  /**
   * The delegates: exactly the repo Original's signer set, `authors.dids`
   * (P5.19), sorted. Kept in the document so a reader of the document alone
   * sees them; the verifier refuses a document that differs from the set
   * (`REPO_DELEGATES_MISMATCH`, K5).
   */
  delegates: string[];
  refs: Record<string, RefRule>;
  /**
   * PROVISIONAL (K15): the release Original's did:vh, once the repo has one:
   * a set Original with the repo's members and threshold, and a child of the
   * repo (K17).
   */
  releases?: string;
}

/** The `code` member of a branch Original's metadata (K4). */
export interface BranchMetadata {
  profile: typeof CODE_PROFILE;
  kind: "branch";
  repo: string;
  ref: string;
  /**
   * The git commit this entry mirrors. Claimed by its signer unless
   * `commitObject` is present, when the verifier recomputes it (K12).
   */
  commit: string;
  /** The git tree id of the commit, recomputable from the objects (`gitBinding`). */
  tree: string;
  /**
   * PROVISIONAL (K12, plan 049 O3): the digest of the raw git commit object,
   * byte for byte, held as a content-addressed object. Absent when the commit
   * object is not mirrored (a private repo without opt-in, or a branch
   * written before K12); the commit id is then claimed only.
   */
  commitObject?: string;
  /**
   * PROVISIONAL (K13, plan 049 O1): on a segment's genesis entry only, the
   * previous segment of the same branch: its did:vh and its last versionId.
   * A branch longer than one Original's entry limit (P7.7) is a chain of
   * segments, each a full Original of its own.
   */
  previous?: { did: string; versionId: string };
}

/** The `code` member of a repo Original's metadata (K5). */
export interface RepoMetadata {
  profile: typeof CODE_PROFILE;
  kind: "repo";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DID = /^did:(?:vh|webvh|btco):[^\s#?]+$/;
const BRANCH_DID = /^did:vh:[1-9A-HJ-NP-Za-km-z]+$/;
const HEX40 = /^[0-9a-f]{40}$/;
const VERSION_ID = /^[1-9][0-9]*-[1-9A-HJ-NP-Za-km-z]+$/;

const sorted = (xs: readonly string[]) => xs.every((x, i) => i === 0 || xs[i - 1] < x);

function exactly(value: unknown, keys: string[]): value is JsonObject {
  return isJsonObject(value) && Object.keys(value).length === keys.length && keys.every((k) => k in value);
}

/** PROVISIONAL: a ref is `refs/heads/<name>` with git's check-ref-format basics. */
export function checkRef(ref: unknown): string {
  const bad = () => codeError("invalid-evidence", "REPO_REF", `${JSON.stringify(ref)} is not a refs/heads/<name> ref`);
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) return bad();
  const name = ref.slice("refs/heads/".length);
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.includes("..") || name.includes("//") || name.startsWith("/") || name.endsWith("/")) bad();
  if (name.split("/").some((s) => s.startsWith(".") || s.endsWith(".lock"))) bad();
  return ref;
}

function checkRepo(value: unknown): RepoDocument {
  if (isJsonObject(value) && value.format !== REPO_FORMAT) codeError("unsupported-profile", "REPO_FORMAT", `unsupported repo document format ${JSON.stringify(value.format)}; only ${REPO_FORMAT} is read`);
  const members = ["delegates", "format", "refs"];
  if (isJsonObject(value) && "releases" in value) members.push("releases");
  if (!exactly(value, members)) codeError("invalid-evidence", "REPO_MEMBERS", "a repo document is exactly { format, delegates, refs, releases? }");
  if (value.format !== REPO_FORMAT) codeError("unsupported-profile", "REPO_FORMAT", `unsupported repo document format ${JSON.stringify(value.format)}`);

  const delegates = value.delegates;
  if (!Array.isArray(delegates) || delegates.length === 0 || !delegates.every((d) => typeof d === "string" && DID.test(d)) || !sorted(delegates as string[])) {
    codeError("invalid-evidence", "REPO_DELEGATES", "delegates are one or more did:vh, did:webvh or did:btco DIDs, unique and sorted");
  }
  const delegateSet = new Set(delegates as string[]);

  if (!isJsonObject(value.refs)) codeError("invalid-evidence", "REPO_MEMBERS", "refs must be an object");
  const seenBranches = new Set<string>();
  const refs: Record<string, RefRule> = {};
  for (const [ref, rule] of Object.entries(value.refs)) {
    checkRef(ref);
    if (!exactly(rule, ["branches", "threshold"])) codeError("invalid-evidence", "REPO_MEMBERS", `${ref} is exactly { threshold, branches }`);
    const t = rule.threshold;
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > delegateSet.size) {
      codeError("invalid-evidence", "REPO_THRESHOLD", `${ref}: threshold must be an integer from 1 to ${delegateSet.size}`);
    }
    if (!isJsonObject(rule.branches)) codeError("invalid-evidence", "REPO_MEMBERS", `${ref}: branches must be an object`);
    const branches: Record<string, string> = {};
    for (const [delegate, branch] of Object.entries(rule.branches)) {
      if (!delegateSet.has(delegate)) codeError("invalid-evidence", "REPO_BRANCH", `${ref}: ${delegate} is not a delegate`);
      if (typeof branch !== "string" || !BRANCH_DID.test(branch)) codeError("invalid-evidence", "REPO_BRANCH", `${ref}: a branch is a did:vh Original`);
      if (seenBranches.has(branch)) codeError("invalid-evidence", "REPO_BRANCH", `${branch} is listed more than once`);
      seenBranches.add(branch);
      branches[delegate] = branch;
    }
    refs[ref] = { threshold: t, branches };
  }

  if ("releases" in value && (typeof value.releases !== "string" || !BRANCH_DID.test(value.releases) || seenBranches.has(value.releases))) {
    codeError("invalid-evidence", "REPO_RELEASES", "releases is the release Original's did:vh, not a branch (K15)");
  }
  return { delegates: delegates as string[], refs, ...(typeof value.releases === "string" ? { releases: value.releases } : {}) };
}

const jcs = (doc: RepoDocument) =>
  canonicalize({ format: REPO_FORMAT, delegates: doc.delegates, refs: doc.refs, ...(doc.releases !== undefined ? { releases: doc.releases } : {}) } as unknown as JsonObject);

/** The canonical bytes of a repo document (JCS), after checking it. */
export function encodeRepoDocument(doc: RepoDocument): Uint8Array {
  return encoder.encode(jcs(checkRepo({ ...doc, format: REPO_FORMAT })));
}

/** Parse a repo document, refusing bytes that are not exactly its JCS form. */
export function decodeRepoDocument(bytes: Uint8Array): RepoDocument {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return codeError("invalid-evidence", "REPO_ENCODING", "a repo document is UTF-8 JSON");
  }
  const doc = checkRepo(parseJson(text));
  if (jcs(doc) !== text) codeError("invalid-evidence", "REPO_NOT_CANONICAL", "a repo document's bytes must be the JCS form of its content");
  return doc;
}

function badMetadata(message: string): never {
  return codeError("invalid-evidence", "BRANCH_METADATA", message);
}

/** A branch entry's asset metadata: exactly `{ code: BranchMetadata }`. */
export function checkBranchMetadata(metadata: unknown): BranchMetadata {
  if (!exactly(metadata, ["code"])) badMetadata("a branch entry's metadata is exactly { code }");
  const code = metadata.code;
  if (isJsonObject(code) && code.profile !== CODE_PROFILE) codeError("unsupported-profile", "CODE_PROFILE", `unsupported code profile ${JSON.stringify(code.profile)}`);
  const members = ["commit", "kind", "profile", "ref", "repo", "tree"];
  if (isJsonObject(code) && "commitObject" in code) members.push("commitObject");
  if (isJsonObject(code) && "previous" in code) members.push("previous");
  if (!exactly(code, members) || code.kind !== "branch") {
    badMetadata("metadata.code is exactly { profile, kind: \"branch\", repo, ref, commit, tree, commitObject?, previous? }");
  }
  if (typeof code.repo !== "string" || !BRANCH_DID.test(code.repo)) badMetadata("metadata.code.repo is the repo Original's did:vh");
  checkRef(code.ref);
  if (typeof code.commit !== "string" || !HEX40.test(code.commit)) badMetadata("metadata.code.commit is a 40-hex git commit id");
  if (typeof code.tree !== "string" || !HEX40.test(code.tree)) badMetadata("metadata.code.tree is a 40-hex git tree id");
  if ("commitObject" in code) {
    try {
      checkDigest(code.commitObject, "metadata.code.commitObject");
    } catch {
      badMetadata("metadata.code.commitObject is an object digest (K12)");
    }
  }
  if ("previous" in code) {
    const p = code.previous;
    if (!exactly(p, ["did", "versionId"]) || typeof p.did !== "string" || !BRANCH_DID.test(p.did) || typeof p.versionId !== "string" || !VERSION_ID.test(p.versionId)) {
      badMetadata("metadata.code.previous is exactly { did, versionId }: the previous segment's did:vh and last versionId (K13)");
    }
  }
  return code as unknown as BranchMetadata;
}

/** A repo Original's asset metadata: exactly `{ code: { profile, kind: "repo" } }`. */
export function checkRepoMetadata(metadata: unknown): RepoMetadata {
  if (!exactly(metadata, ["code"]) || !exactly(metadata.code, ["kind", "profile"]) || metadata.code.kind !== "repo") {
    codeError("invalid-evidence", "REPO_METADATA", "a repo Original's metadata is exactly { code: { profile, kind: \"repo\" } }");
  }
  if (metadata.code.profile !== CODE_PROFILE) codeError("unsupported-profile", "CODE_PROFILE", `unsupported code profile ${JSON.stringify(metadata.code.profile)}`);
  return metadata.code as unknown as RepoMetadata;
}

export function repoMetadata(): JsonObject {
  return { code: { profile: CODE_PROFILE, kind: "repo" } };
}

export function branchMetadata(m: Omit<BranchMetadata, "profile" | "kind">): JsonObject {
  return {
    code: {
      profile: CODE_PROFILE,
      kind: "branch",
      repo: m.repo,
      ref: m.ref,
      commit: m.commit,
      tree: m.tree,
      ...(m.commitObject !== undefined ? { commitObject: m.commitObject } : {}),
      ...(m.previous !== undefined ? { previous: { did: m.previous.did, versionId: m.previous.versionId } } : {}),
    },
  };
}

/** PROVISIONAL (K15): a release manifest's format and media type, the release Original's resource. */
export const RELEASE_FORMAT = "originals-code-release/0.1";
export const RELEASE_MEDIA_TYPE = "application/vnd.originals.code-release+json";

/** One release (K15): what a release Original's entry names, as its resource. */
export interface ReleaseManifest {
  /** The tag name, as git's `refs/tags/<tag>`. */
  tag: string;
  ref: string;
  commit: string;
  /** The branch Original (any segment) whose chain holds the commit, and its entry naming it. */
  branch: string;
  versionId: string;
  /** The canonical head of `ref` when the release was made, as the releaser's verifier reported it. */
  canonical: { status: string; head: string | null; threshold: number; votes: string[] };
}

/** A release Original's asset metadata: exactly `{ code: { profile, kind: "releases", repo } }` (K15). */
export function releasesMetadata(repo: string): JsonObject {
  return { code: { profile: CODE_PROFILE, kind: "releases", repo } };
}

export function checkReleasesMetadata(metadata: unknown): { repo: string } {
  if (!exactly(metadata, ["code"]) || !exactly(metadata.code, ["kind", "profile", "repo"]) || metadata.code.kind !== "releases") {
    codeError("invalid-evidence", "RELEASES_METADATA", "a release Original's metadata is exactly { code: { profile, kind: \"releases\", repo } }");
  }
  if (metadata.code.profile !== CODE_PROFILE) codeError("unsupported-profile", "CODE_PROFILE", `unsupported code profile ${JSON.stringify(metadata.code.profile)}`);
  if (typeof metadata.code.repo !== "string" || !BRANCH_DID.test(metadata.code.repo)) codeError("invalid-evidence", "RELEASES_METADATA", "metadata.code.repo is the repo Original's did:vh");
  return { repo: metadata.code.repo };
}

/** PROVISIONAL: a tag name with git's check-ref-format basics. */
export function checkTag(tag: unknown): string {
  const bad = () => codeError("invalid-evidence", "RELEASE_TAG", `${JSON.stringify(tag)} is not a tag name`);
  if (typeof tag !== "string" || tag.length === 0 || tag.length > 255) return bad();
  if (!/^[A-Za-z0-9._/+-]+$/.test(tag) || tag.includes("..") || tag.includes("//") || tag.startsWith("/") || tag.endsWith("/") || tag.startsWith("-")) bad();
  if (tag.split("/").some((s) => s.startsWith(".") || s.endsWith(".lock"))) bad();
  return tag;
}

function badRelease(why: string): never {
  return codeError("invalid-evidence", "RELEASE_MANIFEST", `a release manifest ${why}`);
}

function checkRelease(value: unknown): ReleaseManifest {
  const bad = badRelease;
  if (!exactly(value, ["branch", "canonical", "commit", "format", "ref", "tag", "versionId"])) badRelease("is exactly { format, tag, ref, commit, branch, versionId, canonical }");
  if (value.format !== RELEASE_FORMAT) codeError("unsupported-profile", "RELEASE_FORMAT", `unsupported release format ${JSON.stringify(value.format)}`);
  checkTag(value.tag);
  checkRef(value.ref);
  if (typeof value.commit !== "string" || !HEX40.test(value.commit)) bad("names a 40-hex commit");
  if (typeof value.branch !== "string" || !BRANCH_DID.test(value.branch)) bad("names a branch Original's did:vh");
  if (typeof value.versionId !== "string" || !VERSION_ID.test(value.versionId)) bad("names the branch entry's versionId");
  const c = value.canonical;
  if (
    !exactly(c, ["head", "status", "threshold", "votes"]) ||
    typeof c.status !== "string" ||
    !["agreed", "no-quorum", "diverged", "incomplete", "inconsistent"].includes(c.status) ||
    !(c.head === null || (typeof c.head === "string" && HEX40.test(c.head))) ||
    typeof c.threshold !== "number" ||
    !Number.isInteger(c.threshold) ||
    c.threshold < 1 ||
    !Array.isArray(c.votes) ||
    !c.votes.every((v) => typeof v === "string" && DID.test(v)) ||
    !sorted(c.votes as string[])
  ) {
    bad("records the canonical result as { status, head, threshold, votes }");
  }
  return value as unknown as ReleaseManifest;
}

const releaseJcs = (r: ReleaseManifest) =>
  canonicalize({ format: RELEASE_FORMAT, tag: r.tag, ref: r.ref, commit: r.commit, branch: r.branch, versionId: r.versionId, canonical: { status: r.canonical.status, head: r.canonical.head, threshold: r.canonical.threshold, votes: r.canonical.votes } });

export function encodeReleaseManifest(r: ReleaseManifest): Uint8Array {
  const text = releaseJcs(r);
  checkRelease(parseJson(text));
  return encoder.encode(text);
}

export function decodeReleaseManifest(bytes: Uint8Array): ReleaseManifest {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return codeError("invalid-evidence", "RELEASE_ENCODING", "a release manifest is UTF-8 JSON");
  }
  const r = checkRelease(parseJson(text));
  if (releaseJcs(r) !== text) codeError("invalid-evidence", "RELEASE_NOT_CANONICAL", "a release manifest's bytes must be the JCS form of its content");
  return r;
}
