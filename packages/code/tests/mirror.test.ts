/**
 * Phase 1: mirroring a git branch into a branch Original, packaging a repo
 * bundle and verifying it offline (plan 049 §3; CODE-03 to CODE-08).
 * Network is disabled for every test (tests/setup.bun.ts throws on fetch).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MemoryStore, OriginalsSDK } from "@originals/sdk/originals";
import { GitSource } from "../src/git.js";
import { MemoryObjectStore, gitTreeIdOf, readBundle, verifyRepository, writeBundle, type CommitSource } from "../src/index.js";
import { FixtureRepo, NOW, setup } from "./helpers.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function source(repo: FixtureRepo) {
  const s = new GitSource(repo.dir);
  cleanup.push(() => s.close());
  return s;
}

/** A small history: nested dirs, an executable, a symlink, a deletion, a merge on main and an empty commit. */
function history(repo: FixtureRepo): string[] {
  cleanup.push(() => repo.remove());
  const c1 = repo.commit({ "README.md": "# fixture\n", "src/a.ts": "export const a = 1;\n", "bin/run": { exec: "#!/bin/sh\necho run\n" } });
  repo.git("checkout", "-q", "-b", "side");
  repo.commit({ "side.txt": "from side\n" });
  repo.git("checkout", "-q", "main");
  const c2 = repo.commit({ "src/a.ts": "export const a = 2;\n", "link": { link: "README.md" } });
  repo.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  const c3 = repo.head();
  const c4 = repo.commit({ "README.md": null, "docs/guide.md": "guide\n" });
  const c5 = repo.commit({}, "empty");
  return [c1, c2, c3, c4, c5];
}

describe("CODE-03 mirror", () => {
  test("one entry per first-parent commit; each tree's git id recomputes from the objects", async () => {
    const { alice, repo, ws } = await setup();
    const commits = history(repo);
    const repoDid = await ws.initRepo({ name: "fixture", identity: alice });
    const result = await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) });
    expect(result.created).toBe(true);
    expect(result.appended).toBe(5);
    expect(result.head.commit).toBe(commits[4]);

    const view = await ws.sdk.get(result.branch);
    expect(view.report.history.status).toBe("valid");
    expect(view.report.validAsOf).not.toBeNull();
    expect(view.current).toBe(false); // P7.10
    // The empty commit keeps the tree: no new resource version (P4.4).
    expect(view.resources).toHaveLength(4);

    const { document } = await ws.repoDocument(repoDid);
    expect(document.refs["refs/heads/main"]).toEqual({ threshold: 1, branches: { [alice.did]: result.branch } });

    for (const v of view.resources) {
      const entry = (await ws.originals.get(result.branch))!.log.split("\n").find((l) => l.includes(v.versionId))!;
      const claimed = (JSON.parse(entry) as { state: { asset: { metadata: { code: { tree: string } } } } }).state.asset.metadata.code.tree;
      expect(await gitTreeIdOf(v.digest, (d) => ws.objects.get(d))).toBe(claimed);
    }
    expect(view.report.state?.metadata).toMatchObject({ code: { commit: commits[4], tree: repo.treeOf(commits[4]) } });
  });
});

describe("CODE-04 / CODE-08 package and verify offline", () => {
  test("a fresh verifier with no key and no network reproduces the canonical head", async () => {
    const { alice, repo, ws } = await setup();
    const commits = history(repo);
    const repoDid = await ws.initRepo({ name: "fixture", identity: alice });
    await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) });
    const bundle = await ws.package(repoDid);

    const report = await verifyRepository(bundle, { now: NOW + 3_600_000 });
    expect(report.current).toBe(false);
    expect(report.repo.report?.validAsOf).not.toBeNull();
    expect(report.repo.code?.history.status).toBe("valid");
    expect(report.branches).toHaveLength(1);
    const b = report.branches[0];
    expect(b.report?.history.status).toBe("valid");
    expect(b.code?.history.status).toBe("valid");
    expect(b.code?.binding.status).toBe("confirmed");
    expect(b.code?.content.status).toBe("complete");
    expect(b.code?.gitBinding).toMatchObject({ status: "matches", checked: 5, unchecked: 0 });
    expect(b.code?.chain.map((c) => c.commit)).toEqual(commits);
    expect(report.canonicalStatus).toBe("computed");
    expect(report.canonical).toEqual([expect.objectContaining({ ref: "refs/heads/main", status: "agreed", head: expect.objectContaining({ commit: commits[4], votes: [alice.did] }) })]);
    expect(report.validAsOf.branches).toEqual([{ original: b.original, checkpoint: b.report!.checkpoint! }]);

    // CODE-08: each Original's package verifies with the SDK alone, unchanged.
    const contents = await readBundle(bundle);
    for (const p of contents.packages) {
      const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: () => NOW + 3_600_000 });
      const loaded = await sdk.load(p.bytes);
      expect(loaded.report.history.status).toBe("valid");
      expect(loaded.report.validAsOf?.checkpoint).toBe(p.checkpoint);
      expect(loaded.manifest.completeness).toBe("complete");
    }
  });
});

describe("CODE-02 dedup across versions", () => {
  test("a blob unchanged across commits is one object; the bundle carries each object once", async () => {
    const { alice, repo, ws } = await setup();
    cleanup.push(() => repo.remove());
    const big = "x".repeat(10_000);
    repo.commit({ "big.txt": big, "a.txt": "1" });
    repo.commit({ "a.txt": "2" });
    repo.commit({ "a.txt": "3" });
    const repoDid = await ws.initRepo({ name: "dedup", identity: alice });
    await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) });
    const objects = ws.objects as MemoryObjectStore;
    // 3 roots + big.txt once + a.txt three times + 3 commit objects (K12).
    expect(objects.size).toBe(10);
    const contents = await readBundle(await ws.package(repoDid));
    expect(contents.manifest.objects.count).toBe(7); // roots travel in the packages
  });
});

describe("CODE-05 missing objects", () => {
  test("a bundle without blobs: content partial, history valid, git binding unchecked — never a pass for content", async () => {
    const { alice, repo, ws } = await setup();
    history(repo);
    const repoDid = await ws.initRepo({ name: "fixture", identity: alice });
    await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) });
    const bundle = await ws.package(repoDid, { omitBlobs: true });
    expect((await readBundle(bundle)).manifest.completeness).toBe("partial");
    const report = await verifyRepository(bundle, { now: NOW + 3_600_000 });
    const b = report.branches[0].code!;
    expect(b.history.status).toBe("valid");
    expect(b.content.status).toBe("partial");
    expect(b.content.missing.length).toBeGreaterThan(0);
    expect(b.gitBinding.status).toBe("unchecked");
    expect(report.canonical[0].status).toBe("agreed");
  });
});

describe("CODE-06 tampering", () => {
  test("an object whose bytes do not match its digest is a digest failure", async () => {
    const { alice, repo, ws } = await setup();
    history(repo);
    const repoDid = await ws.initRepo({ name: "fixture", identity: alice });
    await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) });
    const contents = await readBundle(await ws.package(repoDid));
    const victim = [...contents.objects.keys()].find((d) => !new TextDecoder().decode(contents.objects.get(d)).startsWith('{"entries"'))!;
    const objects = new Map(contents.objects);
    objects.set(victim, new TextEncoder().encode("tampered"));
    const tampered = writeBundle({ repo: contents.manifest.repo, checkpoint: contents.manifest.checkpoint, packages: contents.packages, objects: objects.entries() });
    const report = await verifyRepository(tampered, { now: NOW + 3_600_000 });
    expect(report.branches[0].code?.content.status).toBe("digest-failure");
    expect(report.branches[0].code?.content.failures).toEqual([victim]);
  });

  test("an entry claiming the wrong git tree fails the code history; the Originals report is untouched", async () => {
    const { alice, repo, ws } = await setup();
    history(repo);
    const real = source(repo);
    const lying: CommitSource = {
      firstParent: (ref) => real.firstParent(ref),
      convert: async (c, o) => ({ ...(await real.convert(c, o)), tree: "0".repeat(40) }),
    };
    const repoDid = await ws.initRepo({ name: "fixture", identity: alice });
    await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: lying });
    const report = await verifyRepository(await ws.package(repoDid), { now: NOW + 3_600_000 });
    const b = report.branches[0];
    expect(b.report?.validAsOf).not.toBeNull(); // a valid Original: the code profile is a separate result
    expect(b.code?.history).toMatchObject({ status: "invalid", failure: { code: "GIT_TREE_MISMATCH", index: 0 } });
    expect(b.code?.gitBinding.status).toBe("mismatch");
    expect(report.canonical[0]).toMatchObject({ status: "no-quorum", head: null, delegates: [{ status: "invalid" }] });
  });
});

describe("CODE-07 incremental mirror", () => {
  test("appends only new commits; a force-push is refused, never rebased (P4.5)", async () => {
    const { alice, repo, ws } = await setup();
    cleanup.push(() => repo.remove());
    repo.commit({ "a.txt": "1" });
    repo.commit({ "a.txt": "2" });
    const repoDid = await ws.initRepo({ name: "inc", identity: alice });
    const first = await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) });
    expect(first.appended).toBe(2);
    const c3 = repo.commit({ "a.txt": "3" });
    const second = await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) });
    expect(second).toMatchObject({ created: false, appended: 1, branch: first.branch, head: { commit: c3 } });
    const again = await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) });
    expect(again.appended).toBe(0);

    repo.git("reset", "-q", "--hard", "HEAD~1");
    repo.commit({ "a.txt": "rewritten" });
    await expect(ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) })).rejects.toMatchObject({ code: "MIRROR_DIVERGED", category: "stale-parent" });
    expect((await ws.sdk.get(first.branch)).report.state?.metadata).toMatchObject({ code: { commit: c3 } });
  });
});

describe("gitlinks", () => {
  test("a submodule stops the mirror with GITLINK_UNSUPPORTED (K9)", async () => {
    const { alice, repo, ws } = await setup();
    cleanup.push(() => repo.remove());
    repo.commit({ "a.txt": "1" });
    repo.git("update-index", "--add", "--cacheinfo", `160000,${repo.head()},sub`);
    repo.git("commit", "-q", "-m", "gitlink");
    const repoDid = await ws.initRepo({ name: "sub", identity: alice });
    await expect(ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) })).rejects.toMatchObject({ code: "GITLINK_UNSUPPORTED" });
  });
});


describe("revisions", () => {
  test("a ref can be read from another revision (a remote-tracking branch); option-like revisions are refused", async () => {
    const repo = new FixtureRepo();
    cleanup.push(() => repo.remove());
    const c1 = repo.commit({ "a.txt": "1" });
    repo.commit({ "a.txt": "2" });
    const s = new GitSource(repo.dir, { revisions: { "refs/heads/main": c1 } });
    cleanup.push(() => s.close());
    expect(await s.firstParent("refs/heads/main")).toEqual([c1]);
    const bad = new GitSource(repo.dir, { revisions: { "refs/heads/main": "--all" } });
    cleanup.push(() => bad.close());
    await expect(bad.firstParent("refs/heads/main")).rejects.toMatchObject({ code: "GIT_REVISION" });
  });
});
