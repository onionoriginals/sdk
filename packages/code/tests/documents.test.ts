/**
 * Path-grant patterns (K7), the repo document (K5, CODE-09) and branch
 * metadata (K4).
 */
import { describe, expect, test } from "bun:test";
import {
  REPO_FORMAT,
  checkBranchMetadata,
  checkPattern,
  covers,
  decodeRepoDocument,
  encodeRepoDocument,
  matchPattern,
  type RepoDocument,
} from "../src/index.js";

const A = "did:vh:QmAlice";
const B = "did:vh:QmBob";
const C = "did:vh:QmCarol";
const BRANCH_A = "did:vh:QmBranchA";
const BRANCH_B = "did:vh:QmBranchB";

describe("K7 path patterns", () => {
  test.each([
    ["packages/vh/**", "packages/vh/src/index.ts", true],
    ["packages/vh/**", "packages/vh", false],
    ["packages/vh/**", "packages/vhx/a", false],
    ["packages/*/package.json", "packages/sdk/package.json", true],
    ["packages/*/package.json", "packages/sdk/x/package.json", false],
    ["**/README.md", "README.md", true],
    ["**/README.md", "a/b/README.md", true],
    ["*.md", "a.md", true],
    ["*.md", "dir/a.md", false],
    ["a/**/z", "a/z", true],
    ["a/**/z", "a/b/c/z", true],
    ["**", "anything/at/all", true],
    ["docs/a?.md", "docs/a?.md", true],
    ["docs/a?.md", "docs/ab.md", false],
  ])("%s matches %s: %s", (pattern, path, expected) => {
    expect(matchPattern(pattern, path)).toBe(expected);
  });

  test.each(["", "/abs", "a//b", "a/", "./a", "a/../b", "a**", "**b/c", "a/b**"])("refuses the pattern %j", (p) => {
    expect(() => checkPattern(p)).toThrow(expect.objectContaining({ code: "GRANT_PATTERN" }));
  });

  test("covers needs every path under some pattern", () => {
    expect(covers(["packages/vh/**", "docs/*.md"], ["packages/vh/a.ts", "docs/x.md"])).toEqual([]);
    expect(covers(["packages/vh/**"], ["packages/vh/a.ts", "packages/sdk/b.ts"])).toEqual(["packages/sdk/b.ts"]);
  });
});

describe("CODE-09 repo document", () => {
  const doc: RepoDocument = {
    delegates: [A, B],
    refs: { "refs/heads/main": { threshold: 2, branches: { [A]: BRANCH_A, [B]: BRANCH_B } } },
    grants: [{ did: C, paths: ["packages/vh/**"] }],
  };

  test("round-trips as JCS bytes", () => {
    const bytes = encodeRepoDocument(doc);
    expect(JSON.parse(new TextDecoder().decode(bytes)).format).toBe(REPO_FORMAT);
    expect(decodeRepoDocument(bytes)).toEqual(doc);
  });

  test("threshold is an integer from 1 to the number of delegates", () => {
    for (const threshold of [0, 3, 1.5]) {
      expect(() => encodeRepoDocument({ ...doc, refs: { "refs/heads/main": { threshold, branches: {} } } })).toThrow(expect.objectContaining({ code: "REPO_THRESHOLD" }));
    }
  });

  test("a branch is listed under a delegate, and each branch Original once", () => {
    expect(() => encodeRepoDocument({ ...doc, refs: { "refs/heads/main": { threshold: 1, branches: { [C]: BRANCH_A } } } })).toThrow(expect.objectContaining({ code: "REPO_BRANCH" }));
    expect(() =>
      encodeRepoDocument({ ...doc, refs: { "refs/heads/main": { threshold: 1, branches: { [A]: BRANCH_A } }, "refs/heads/dev": { threshold: 1, branches: { [B]: BRANCH_A } } } }),
    ).toThrow(expect.objectContaining({ code: "REPO_BRANCH" }));
  });

  test("delegates are unique and sorted (one encoding per document)", () => {
    expect(() => encodeRepoDocument({ ...doc, delegates: [B, A] })).toThrow(expect.objectContaining({ code: "REPO_DELEGATES" }));
    expect(() => encodeRepoDocument({ ...doc, delegates: [A, A] })).toThrow(expect.objectContaining({ code: "REPO_DELEGATES" }));
    expect(() => encodeRepoDocument({ ...doc, delegates: [] })).toThrow(expect.objectContaining({ code: "REPO_DELEGATES" }));
  });

  test("ref names are refs/heads/<name> without traversal", () => {
    for (const ref of ["main", "refs/heads/", "refs/heads/a..b", "refs/heads/a//b", "refs/heads/x.lock", "refs/tags/v1"]) {
      expect(() => encodeRepoDocument({ ...doc, refs: { [ref]: { threshold: 1, branches: {} } } })).toThrow(expect.objectContaining({ code: "REPO_REF" }));
    }
  });

  test("grants name unique DIDs with valid, sorted patterns", () => {
    expect(() => encodeRepoDocument({ ...doc, grants: [{ did: C, paths: [] }] })).toThrow(expect.objectContaining({ code: "REPO_GRANTS" }));
    expect(() => encodeRepoDocument({ ...doc, grants: [{ did: C, paths: ["/x"] }] })).toThrow(expect.objectContaining({ code: "GRANT_PATTERN" }));
    expect(() => encodeRepoDocument({ ...doc, grants: [{ did: C, paths: ["a"] }, { did: C, paths: ["b"] }] })).toThrow(expect.objectContaining({ code: "REPO_GRANTS" }));
  });

  test("non-canonical bytes and extra members are refused", () => {
    const text = new TextDecoder().decode(encodeRepoDocument(doc));
    expect(() => decodeRepoDocument(new TextEncoder().encode(` ${text}`))).toThrow(expect.objectContaining({ code: "REPO_NOT_CANONICAL" }));
    const extra = JSON.parse(text) as Record<string, unknown>;
    extra.owner = A;
    expect(() => decodeRepoDocument(new TextEncoder().encode(JSON.stringify(extra)))).toThrow(expect.objectContaining({ code: "REPO_MEMBERS" }));
  });
});

describe("K4 branch metadata", () => {
  const code = { profile: "originals-code/0.1", kind: "branch", repo: "did:vh:QmRepo", ref: "refs/heads/main", commit: "a".repeat(40), tree: "b".repeat(40), repoVersion: "1-QmX" };

  test("is exactly { code: { profile, kind, repo, ref, commit, tree, repoVersion } }", () => {
    expect(checkBranchMetadata({ code })).toEqual(code);
    expect(() => checkBranchMetadata({ code, other: 1 })).toThrow(expect.objectContaining({ code: "BRANCH_METADATA" }));
    expect(() => checkBranchMetadata({ code: { ...code, author: "x" } })).toThrow(expect.objectContaining({ code: "BRANCH_METADATA" }));
    expect(() => checkBranchMetadata({ code: { ...code, commit: "A".repeat(40) } })).toThrow(expect.objectContaining({ code: "BRANCH_METADATA" }));
    expect(() => checkBranchMetadata(undefined)).toThrow(expect.objectContaining({ code: "BRANCH_METADATA" }));
    expect(() => checkBranchMetadata({ code: { ...code, profile: "originals-code/9" } })).toThrow(expect.objectContaining({ code: "CODE_PROFILE" }));
  });
});
