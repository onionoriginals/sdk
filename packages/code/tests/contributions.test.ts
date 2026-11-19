/**
 * Contributor branches (plan 049 O7, decided 2026-11-19; PROVISIONAL K14;
 * CODE-23, CODE-24): anyone may publish their own branch Original for a ref.
 * It names the repo, is not listed under a delegate, is verified and
 * reported as a contribution, and never votes for a canonical head.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { GitSource } from "../src/git.js";
import { verifyRepository, type CommitSource } from "../src/index.js";
import { FixtureRepo, NOW, identity, workspace } from "./helpers.js";

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

function repoWith(from?: FixtureRepo) {
  const r = new FixtureRepo(from);
  cleanup.push(() => r.remove());
  return r;
}

/** Alice (the delegate) mirrors main; Bob takes her bundle and contributes one commit on top. */
async function scenario(options: { document?: (alice: string, dave: string) => object } = {}) {
  const alice = await identity(1);
  const bob = await identity(2);
  const dave = await identity(4);
  const upstream = repoWith();
  const c1 = upstream.commit({ "a.txt": "1\n" });
  const c2 = upstream.commit({ "a.txt": "2\n" });
  const aliceWs = workspace();
  const repoDid = await aliceWs.initRepo({ name: "contrib", identity: alice, ...(options.document ? { document: options.document(alice.did, dave.did) } : {}) });
  const a = await aliceWs.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: source(upstream) });

  const bobWs = workspace();
  const imported = await bobWs.importBundle(await aliceWs.package(repoDid));
  expect(imported.repo).toBe(repoDid);
  const fork = repoWith(upstream);
  const c3 = fork.commit({ "b.txt": "bob\n" });
  return { alice, bob, aliceWs, bobWs, repoDid, a, fork, commits: [c1, c2, c3] };
}

describe("CODE-23 a contributor's own branch", () => {
  test("verified and reported as a contribution; the canonical head ignores it", async () => {
    const { alice, bob, bobWs, repoDid, a, fork, commits } = await scenario();
    const r = await bobWs.mirror({ repo: repoDid, ref: MAIN, identity: bob, source: source(fork), contribute: true });
    expect(r).toMatchObject({ contribution: true, created: true, appended: 3, head: { commit: commits[2] } });
    expect(r.needsListing).toBeUndefined();
    // The repo document is unchanged: nothing lists Bob.
    expect((await bobWs.repoDocument(repoDid)).document.refs[MAIN].branches).toEqual({ [alice.did]: a.branch });

    const report = await verifyRepository(await bobWs.package(repoDid, { contributions: [r.branch] }), later);
    const mine = report.branches.find((b) => b.original === r.branch)!;
    expect(mine.report?.validAsOf).not.toBeNull();
    expect(mine.code?.history.status).toBe("valid");
    expect(mine.code?.binding).toEqual({ status: "contribution" });
    expect(report.contributions).toEqual([{ original: r.branch, author: bob.did, ref: MAIN, status: "valid", head: commits[2], segments: 1 }]);
    // Alice's head stays canonical: a contribution never votes.
    expect(report.canonical[0]).toMatchObject({ status: "agreed", head: { commit: commits[1] } });
    expect(report.canonical[0].delegates.map((d) => d.branch)).toEqual([a.branch]);
  });

  test("a contribution does not make up a missing quorum", async () => {
    // Two delegates, threshold 2; only Alice has a branch. Bob's contribution holds the same commits and more.
    const { alice, bob, aliceWs, repoDid, fork, commits } = await scenario({ document: (a, d) => ({ delegates: [a, d].sort(), refs: {}, grants: [] }) });
    await aliceWs.updateRepo(repoDid, alice, (doc) => ({ ...doc, refs: { [MAIN]: { ...doc.refs[MAIN], threshold: 2 } } }));
    const bobWs = workspace();
    await bobWs.importBundle(await aliceWs.package(repoDid));
    const r = await bobWs.mirror({ repo: repoDid, ref: MAIN, identity: bob, source: source(fork), contribute: true });
    const report = await verifyRepository(await bobWs.package(repoDid, { contributions: [r.branch] }), later);
    expect(report.contributions[0]).toMatchObject({ status: "valid", head: commits[2] });
    expect(report.canonical[0]).toMatchObject({ status: "no-quorum", head: null, threshold: 2 });
  });

  test("a later contribution mirror extends the contributor's own branch", async () => {
    const { bob, bobWs, repoDid, fork } = await scenario();
    const first = await bobWs.mirror({ repo: repoDid, ref: MAIN, identity: bob, source: source(fork), contribute: true });
    const c4 = fork.commit({ "b.txt": "bob 2\n" });
    const again = await bobWs.mirror({ repo: repoDid, ref: MAIN, identity: bob, source: source(fork), contribute: true, branch: first.branch });
    expect(again).toMatchObject({ created: false, appended: 1, branch: first.branch, head: { commit: c4 } });
    expect(await bobWs.findBranch([first.branch], bob.did, MAIN)).toBe(first.branch);
  });
});

describe("CODE-24 contributions stay outside the vote", () => {
  test("an invalid contribution is reported as such and leaves the canonical head alone", async () => {
    const { bob, bobWs, repoDid, fork, commits } = await scenario();
    const real = source(fork);
    const lying: CommitSource = { firstParent: (ref) => real.firstParent(ref), convert: async (c, o) => ({ ...(await real.convert(c, o)), tree: "0".repeat(40) }) };
    const r = await bobWs.mirror({ repo: repoDid, ref: MAIN, identity: bob, source: lying, contribute: true });
    const report = await verifyRepository(await bobWs.package(repoDid, { contributions: [r.branch] }), later);
    expect(report.contributions[0]).toMatchObject({ status: "invalid", head: null });
    expect(report.canonical[0]).toMatchObject({ status: "agreed", head: { commit: commits[1] } });
  });

  test("a contribution cannot be written into a delegate's listed branch", async () => {
    const { bob, bobWs, repoDid, a, fork } = await scenario();
    await expect(bobWs.mirror({ repo: repoDid, ref: MAIN, identity: bob, source: source(fork), contribute: true, branch: a.branch })).rejects.toMatchObject({ code: "CONTRIBUTION_LISTED" });
  });

  test("a bundle whose repo Original does not verify is not imported", async () => {
    const ws = workspace();
    const { aliceWs, repoDid } = await scenario();
    const bundle = await aliceWs.package(repoDid);
    const bad = bundle.slice();
    // Corrupt the repo document bytes inside its package: the repo Original no longer verifies.
    const at = new TextDecoder("latin1").decode(bad).indexOf("originals-code-repo/0.1");
    bad[at] = "X".charCodeAt(0);
    await expect(ws.importBundle(bad)).rejects.toThrow();
  });
});
