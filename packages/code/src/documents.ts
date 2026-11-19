/**
 * The repo document and branch metadata of `originals-code/0.1` (plan 049
 * §1.2, §1.3). Every member name and rule here is PROVISIONAL (K4, K5): the
 * code profile is layered on `originals:1.0` and changes none of its rules.
 */
import { canonicalize, isJsonObject, parseJson, type JsonObject } from "@originals/vh/json";
import { checkDigest } from "@originals/vh/originals";
import { checkPattern } from "./grants.js";
import { codeError } from "./errors.js";

/** PROVISIONAL (K1): the code profile, layered on `originals:1.0`. */
export const CODE_PROFILE = "originals-code/0.1";
/** PROVISIONAL (K5): the repo document format. */
export const REPO_FORMAT = "originals-code-repo/0.1";
/** PROVISIONAL (K3): the repo document's media type, the repo Original's resource. */
export const REPO_MEDIA_TYPE = "application/vnd.originals.code-repo+json";

export interface RefRule {
  /** How many delegates must agree on a commit for it to be the canonical head (1 ≤ threshold ≤ delegates). */
  threshold: number;
  /** Each delegate's branch Original for this ref: delegate DID → branch did:vh. */
  branches: Record<string, string>;
}

export interface PathGrant {
  did: string;
  paths: string[];
}

export interface RepoDocument {
  delegates: string[];
  refs: Record<string, RefRule>;
  grants: PathGrant[];
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
  /** The repo Original's version this entry was made under; path grants are judged against it. */
  repoVersion: string;
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
  if (!exactly(value, ["delegates", "format", "grants", "refs"])) codeError("invalid-evidence", "REPO_MEMBERS", "a repo document is exactly { format, delegates, refs, grants }");
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

  if (!Array.isArray(value.grants)) codeError("invalid-evidence", "REPO_GRANTS", "grants must be an array");
  const grants: PathGrant[] = [];
  for (const g of value.grants) {
    if (!exactly(g, ["did", "paths"]) || typeof g.did !== "string" || !DID.test(g.did)) codeError("invalid-evidence", "REPO_GRANTS", "a grant is exactly { did, paths }");
    const paths = g.paths;
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string")) codeError("invalid-evidence", "REPO_GRANTS", `${g.did}: paths are one or more patterns`);
    for (const p of paths) checkPattern(p);
    if (!sorted(paths)) codeError("invalid-evidence", "REPO_GRANTS", `${g.did}: paths are unique and sorted`);
    grants.push({ did: g.did, paths: paths });
  }
  if (!sorted(grants.map((g) => g.did))) codeError("invalid-evidence", "REPO_GRANTS", "grants name unique DIDs, sorted by DID");
  return { delegates: delegates as string[], refs, grants };
}

const jcs = (doc: RepoDocument) => canonicalize({ ...doc, format: REPO_FORMAT } as unknown as JsonObject);

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
  const members = ["commit", "kind", "profile", "ref", "repo", "repoVersion", "tree"];
  if (isJsonObject(code) && "commitObject" in code) members.push("commitObject");
  if (isJsonObject(code) && "previous" in code) members.push("previous");
  if (!exactly(code, members) || code.kind !== "branch") {
    badMetadata("metadata.code is exactly { profile, kind: \"branch\", repo, ref, commit, tree, repoVersion, commitObject?, previous? }");
  }
  if (typeof code.repo !== "string" || !BRANCH_DID.test(code.repo)) badMetadata("metadata.code.repo is the repo Original's did:vh");
  checkRef(code.ref);
  if (typeof code.commit !== "string" || !HEX40.test(code.commit)) badMetadata("metadata.code.commit is a 40-hex git commit id");
  if (typeof code.tree !== "string" || !HEX40.test(code.tree)) badMetadata("metadata.code.tree is a 40-hex git tree id");
  if (typeof code.repoVersion !== "string" || !VERSION_ID.test(code.repoVersion)) badMetadata("metadata.code.repoVersion is a versionId");
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
      repoVersion: m.repoVersion,
      ...(m.commitObject !== undefined ? { commitObject: m.commitObject } : {}),
      ...(m.previous !== undefined ? { previous: { did: m.previous.did, versionId: m.previous.versionId } } : {}),
    },
  };
}
