/**
 * Branch segments (plan 049 O1, decided 2026-11-19; PROVISIONAL K13;
 * CODE-21, CODE-22): a branch longer than one Original's entry limit (P7.7)
 * is a chain of segment Originals, each genesis naming the previous segment's
 * did and last versionId. Tested with a small injected limit.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MemoryStore } from "@originals/sdk/originals";
import { GitSource } from "../src/git.js";
import { CodeWorkspace, MemoryObjectStore, appendCommits, identityRef, identitySigner, readBundle, verifyRepository, writeBundle, type CommitSource } from "../src/index.js";
import { FixtureRepo, NOW, identity, importRaw, logOf, ticking } from "./helpers.js";

const MAIN = "refs/heads/main";
const later = { now: NOW + 3_600_000 };
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function source(repo: FixtureRepo) {
  const s = new GitSource(repo.dir);
  cleanup.push(() => s.close());
  return s;
}

function fixture(n: number): { repo: FixtureRepo; commits: string[] } {
  const repo = new FixtureRepo();
  cleanup.push(() => repo.remove());
  const commits: string[] = [];
  for (let i = 0; i < n; i++) commits.push(repo.commit({ "a.txt": `${i}\n`, [`f${i}.txt`]: "x" }));
  return { repo, commits };
}

async function setup(segmentEntries = 2) {
  const alice = await identity(1);
  const ws = CodeWorkspace.create({ originals: new MemoryStore(), objects: new MemoryObjectStore(), clock: ticking(), segmentEntries });
  return { alice, ws };
}

describe("CODE-21 a branch as a chain of segments", () => {
  test("the writer starts a new segment at the limit; the repo lists the newest; the verifier walks the chain", async () => {
    const { alice, ws } = await setup(2);
    const { repo, commits } = fixture(5);
    const repoDid = await ws.initRepo({ name: "seg", identity: alice });
    const r = await ws.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: source(repo) });
    expect(r).toMatchObject({ appended: 5, segments: 3, head: { commit: commits[4] } });
    expect(r.newSegments).toHaveLength(3);
    expect(r.branch).toBe(r.newSegments[2]);
    const { document } = await ws.repoDocument(repoDid);
    expect(document.refs[MAIN].branches[alice.did]).toBe(r.branch); // the current segment

    const second = await logOf(ws, r.newSegments[1]);
    const first = await logOf(ws, r.newSegments[0]);
    expect((second[0].state as { asset: { metadata: { code: { previous: unknown } } } }).asset.metadata.code.previous).toEqual({ did: r.newSegments[0], versionId: first[1].versionId });

    const report = await verifyRepository(await ws.package(repoDid), later);
    expect(report.branches).toHaveLength(3); // every segment travels in the bundle
    const byDid = new Map(report.branches.map((b) => [b.original, b]));
    const head = byDid.get(r.branch)!.code!;
    expect(head.history.status).toBe("valid");
    expect(head.binding.status).toBe("confirmed");
    expect(head.segment).toEqual({ index: 2, previous: { did: r.newSegments[1], versionId: second[1].versionId }, segments: r.newSegments });
    expect(head.chain.map((c) => c.commit)).toEqual(commits);
    // Commit continuity across segments: each genesis's first parent is the previous segment's last commit.
    expect(head.commitBinding).toMatchObject({ status: "matches", checked: 1, base: null });
    for (const s of r.newSegments.slice(0, 2)) {
      expect(byDid.get(s)!.code!.history.status).toBe("valid");
      expect(byDid.get(s)!.code!.binding).toEqual({ status: "superseded", delegate: alice.did });
      expect(byDid.get(s)!.report?.validAsOf).not.toBeNull();
    }
    expect(report.canonical[0]).toMatchObject({ status: "agreed", head: { commit: commits[4] } });
  });

  test("an incremental mirror crosses a segment boundary", async () => {
    const { alice, ws } = await setup(3);
    const { repo, commits } = fixture(2);
    const repoDid = await ws.initRepo({ name: "seg", identity: alice });
    const a = await ws.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: source(repo) });
    expect(a.segments).toBe(1);
    for (let i = 2; i < 5; i++) commits.push(repo.commit({ "a.txt": `${i}\n` }));
    const b = await ws.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: source(repo) });
    expect(b).toMatchObject({ created: false, appended: 3, segments: 2 });
    expect(b.newSegments).toHaveLength(1);
    const again = await ws.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: source(repo) });
    expect(again).toMatchObject({ appended: 0, branch: b.branch });
    const report = await verifyRepository(await ws.package(repoDid), later);
    expect(report.canonical[0]).toMatchObject({ status: "agreed", head: { commit: commits[4] } });
  });
});

describe("CODE-22 segment continuity failures", () => {
  test("a missing previous segment is incomplete, never a pass", async () => {
    const { alice, ws } = await setup(2);
    const { repo } = fixture(3);
    const repoDid = await ws.initRepo({ name: "seg", identity: alice });
    const r = await ws.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: source(repo) });
    const contents = await readBundle(await ws.package(repoDid));
    const packages = contents.packages.filter((p) => p.original !== r.newSegments[0]);
    const bundle = writeBundle({ repo: contents.manifest.repo, checkpoint: contents.manifest.checkpoint, packages, objects: contents.objects.entries() });
    const report = await verifyRepository(bundle, later);
    const head = report.branches.find((b) => b.original === r.branch)!;
    expect(head.code?.history).toMatchObject({ status: "incomplete", failure: { code: "SEGMENT_PREVIOUS_MISSING", index: 0 } });
    expect(report.canonical[0]).toMatchObject({ status: "incomplete", head: null });
  });

  test("a closed segment that continues after the entry the next genesis names is invalid", async () => {
    const { alice, ws } = await setup(2);
    const { repo, commits } = fixture(3);
    const repoDid = await ws.initRepo({ name: "seg", identity: alice });
    const r = await ws.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: source(repo) });
    // Append one more entry to the first segment, past the limit the writer keeps.
    const first = await logOf(ws, r.newSegments[0]);
    const s = source(repo);
    const extra = await s.convert(commits[2], ws.objects);
    const { versionId } = await ws.repoDocument(repoDid);
    const more = await appendCommits({ log: first, commits: [extra], repo: repoDid, ref: MAIN, repoVersion: versionId, signer: { role: "author", ref: identityRef(alice), sign: identitySigner(alice) }, clock: ticking(NOW + 30_000) });
    await importRaw(ws, [...first, ...more], [alice], r.newSegments[0]);
    const report = await verifyRepository(await ws.package(repoDid), later);
    const head = report.branches.find((b) => b.original === r.branch)!;
    expect(head.code?.history).toMatchObject({ status: "invalid", failure: { code: "SEGMENT_CONTINUED" } });
    expect(report.canonical[0]).toMatchObject({ status: "no-quorum", head: null });
  });

  test("a segment whose first commit does not follow the previous segment's last commit", async () => {
    const { alice, ws } = await setup(2);
    const { repo } = fixture(5);
    const real = source(repo);
    const skipping: CommitSource = {
      firstParent: async (ref) => {
        const all = await real.firstParent(ref);
        return [...all.slice(0, 2), ...all.slice(3)]; // drops the commit at the boundary
      },
      convert: (c, o, opts) => real.convert(c, o, opts),
    };
    const repoDid = await ws.initRepo({ name: "seg", identity: alice });
    const r = await ws.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: skipping });
    const report = await verifyRepository(await ws.package(repoDid), later);
    const second = report.branches.find((b) => b.original === r.newSegments[1])!;
    expect(second.code?.history).toMatchObject({ status: "invalid", failure: { code: "COMMIT_PARENT_MISMATCH", index: 0 } });
    expect(report.canonical[0].status).toBe("no-quorum");
  });

  test("only the branch's author starts the next segment", async () => {
    const { alice, ws } = await setup(2);
    const bob = await identity(2);
    const { repo, commits } = fixture(2);
    const repoDid = await ws.initRepo({ name: "seg", identity: alice });
    const r = await ws.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: source(repo) });
    await ws.updateRepo(repoDid, alice, (d) => ({ ...d, grants: [{ did: bob.did, paths: ["**"] }] }));
    await ws.grantEditors(r.branch, alice, [{ did: bob.did, name: false, metadata: true, resource: true }]);
    commits.push(repo.commit({ "b.txt": "b" }));
    await expect(ws.mirror({ repo: repoDid, ref: MAIN, identity: bob, source: source(repo), branch: r.branch })).rejects.toMatchObject({ code: "SEGMENT_AUTHOR_ONLY" });
  });
});
