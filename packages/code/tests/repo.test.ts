/**
 * Phase 2: the repo Original, binding both ways, and canonical heads across
 * several delegates (plan 049; CODE-09, CODE-10, CODE-11). Threshold
 * agreement is over signed first-parent chains; nothing is chosen by
 * timestamp or length (P2.1); a fork in one delegate's log stays an
 * unresolved conflict (P6.6, P9.16).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { keySigner, writeEvidence } from "@originals/sdk/originals";
import { serializeLog } from "@originals/vh/log";
import { GitSource } from "../src/git.js";
import { REPO_MEDIA_TYPE, appendCommits, encodeRepoDocument, identityEvidence, identityRef, identitySigner, readBundle, verifyRepository, writeBundle } from "../src/index.js";
import { FixtureRepo, NOW, identity, logOf, workspace } from "./helpers.js";

const MAIN = "refs/heads/main";
const LATER = NOW + 3_600_000;
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
function fixture(from?: FixtureRepo) {
  const r = new FixtureRepo(from);
  cleanup.push(() => r.remove());
  return r;
}
function source(repo: FixtureRepo) {
  const s = new GitSource(repo.dir);
  cleanup.push(() => s.close());
  return s;
}

/** Alice (repo author) and Bob are delegates of main; each mirrors their own clone. */
async function twoDelegates(threshold: number) {
  const alice = await identity(1);
  const bob = await identity(2);
  const ws = workspace();
  ws.addIdentity(bob);
  const upstream = fixture();
  const c1 = upstream.commit({ "a.txt": "1" });
  const c2 = upstream.commit({ "a.txt": "2" });
  const bobRepo = fixture(upstream);
  const repo = await ws.initRepo({ name: "two", identity: alice, document: { delegates: [alice.did, bob.did].sort() } });
  const a = await ws.mirror({ repo, ref: MAIN, identity: alice, source: source(upstream) });
  const b = await ws.mirror({ repo, ref: MAIN, identity: bob, source: source(bobRepo) });
  expect(a.needsListing).toBeUndefined();
  expect(b.needsListing).toBe(true); // only the repo's author changes the repo document (P5.2; phase 4)
  await ws.listBranch(repo, alice, { ref: MAIN, delegate: bob.did, branch: b.branch, threshold });
  return { alice, bob, ws, upstream, bobRepo, repo, aliceBranch: a.branch, bobBranch: b.branch, c1, c2 };
}

describe("CODE-10 canonical heads across delegates", () => {
  test("threshold 2: both delegates at the same head agree", async () => {
    const t = await twoDelegates(2);
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    expect(report.canonical).toEqual([expect.objectContaining({ status: "agreed", head: expect.objectContaining({ commit: t.c2, votes: [t.alice.did, t.bob.did].sort() }) })]);
  });

  test("threshold 2: one delegate ahead leaves the head at the newest commit both hold", async () => {
    const t = await twoDelegates(2);
    t.upstream.commit({ "a.txt": "3" });
    await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.alice, source: source(t.upstream) });
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    expect(report.canonical[0]).toMatchObject({ status: "agreed", head: { commit: t.c2 } });
    expect(report.canonical[0].delegates.find((d) => d.delegate === t.alice.did)?.head).toBe(t.upstream.head());
  });

  test("threshold 1 with diverging delegates: diverged, no head, even when one branch is longer and later (P2.1)", async () => {
    const t = await twoDelegates(1);
    const a3 = t.upstream.commit({ "a.txt": "alice" });
    await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.alice, source: source(t.upstream) });
    t.bobRepo.commit({ "a.txt": "bob" });
    t.bobRepo.commit({ "b.txt": "more" });
    const b5 = t.bobRepo.commit({ "c.txt": "even more" });
    await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.bob, source: source(t.bobRepo) });
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    expect(report.canonical[0].status).toBe("diverged");
    expect(report.canonical[0].head).toBeNull();
    expect(report.canonical[0].tips?.map((x) => x.commit).sort()).toEqual([a3, b5].sort());
  });

  test("threshold 2 with diverging delegates: the last commit both chains hold", async () => {
    const t = await twoDelegates(2);
    t.upstream.commit({ "a.txt": "alice" });
    await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.alice, source: source(t.upstream) });
    t.bobRepo.commit({ "a.txt": "bob" });
    await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.bob, source: source(t.bobRepo) });
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    expect(report.canonical[0]).toMatchObject({ status: "agreed", head: { commit: t.c2 } });
  });

  test("a listed branch missing from the bundle is incomplete, never a pass (section 7)", async () => {
    const t = await twoDelegates(1);
    const contents = await readBundle(await t.ws.package(t.repo));
    const without = writeBundle({
      repo: contents.manifest.repo,
      checkpoint: contents.manifest.checkpoint,
      packages: contents.packages.filter((p) => p.original !== t.bobBranch),
      objects: contents.objects.entries(),
    });
    const report = await verifyRepository(without, { now: LATER });
    expect(report.canonical[0]).toMatchObject({ status: "incomplete", head: null });
    expect(report.canonical[0].delegates.find((d) => d.delegate === t.bob.did)?.status).toBe("missing");
  });

  test("a bundle without its repo Original computes no canonical head", async () => {
    const t = await twoDelegates(1);
    const contents = await readBundle(await t.ws.package(t.repo));
    const without = writeBundle({ repo: contents.manifest.repo, checkpoint: contents.manifest.checkpoint, packages: contents.packages.filter((p) => p.original !== t.repo), objects: contents.objects.entries() });
    const report = await verifyRepository(without, { now: LATER });
    expect(report.canonicalStatus).toBe("incomplete");
    expect(report.canonical).toEqual([]);
    expect(report.repo.error?.code).toBe("REPO_MISSING");
  });
});

describe("CODE-11 a fork inside one delegate's branch", () => {
  test("is reported as an unresolved fork; that branch does not vote and the others decide", async () => {
    const t = await twoDelegates(1);
    // Bob's branch Original gets a second, divergent continuation from its first entry.
    const log = await logOf(t.ws, t.bobBranch);
    const other = fixture(t.upstream);
    other.git("reset", "-q", "--hard", t.c1);
    const alt = other.commit({ "a.txt": "alternative" });
    const s = source(other);
    const converted = await s.convert(alt, t.ws.objects);
    const { versionId: repoVersion } = await t.ws.repoDocument(t.repo);
    const fork = [log[0], ...(await appendCommits({ log: [log[0]], commits: [converted], repo: t.repo, ref: MAIN, repoVersion, signer: { role: "author", ref: identityRef(t.bob), sign: identitySigner(t.bob) }, clock: () => LATER - 1000 }))];
    const forkZip = writeEvidence({
      manifest: { format: "originals-evidence/0.1", profile: "originals:1.0", original: t.bobBranch, checkpoint: fork[1].versionId, head: fork[1].versionId, completeness: "complete", missing: [] },
      log: serializeLog(fork),
      authors: [identityEvidence(t.bob)],
      bytes: Object.fromEntries(await Promise.all(fork.map(async (e) => {
        const d = (e.state as { asset: { resource: { digest: string } } }).asset.resource.digest;
        return [d, (await t.ws.objects.get(d)) ?? (await t.ws.sdk.resourceBytes(d))!] as const;
      }))),
    });
    const contents = await readBundle(await t.ws.package(t.repo));
    const bundle = writeBundle({
      repo: contents.manifest.repo,
      checkpoint: contents.manifest.checkpoint,
      packages: [...contents.packages, { original: t.bobBranch, checkpoint: fork[1].versionId, bytes: forkZip }],
      objects: contents.objects.entries(),
    });
    const report = await verifyRepository(bundle, { now: LATER });
    const bob = report.branches.find((b) => b.original === t.bobBranch)!;
    expect(bob.packages).toHaveLength(2);
    expect(bob.report?.fork).not.toBeNull();
    expect(bob.report?.validAsOf).toBeNull();
    expect(report.canonical[0]).toMatchObject({ status: "agreed", head: { commit: t.c2, votes: [t.alice.did] } });
    expect(report.canonical[0].delegates.find((d) => d.delegate === t.bob.did)?.status).toBe("forked");
  });
});

describe("CODE-09 binding both ways", () => {
  test("a branch listed under a delegate who did not author it does not count", async () => {
    const t = await twoDelegates(1);
    // Alice lists Bob's branch as hers for another ref.
    await t.ws.updateRepo(t.repo, t.alice, (doc) => {
      delete doc.refs[MAIN].branches[t.bob.did];
      doc.refs["refs/heads/dev"] = { threshold: 1, branches: { [t.alice.did]: t.bobBranch } };
      return doc;
    });
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    const bob = report.branches.find((b) => b.original === t.bobBranch)!;
    expect(bob.code?.binding).toMatchObject({ status: "mismatch" });
    const dev = report.canonical.find((c) => c.ref === "refs/heads/dev")!;
    expect(dev).toMatchObject({ status: "no-quorum", delegates: [{ status: "invalid" }] });
  });

  test("a branch naming another repo fails its code history", async () => {
    const alice = await identity(1);
    const ws = workspace();
    const up = fixture();
    up.commit({ "a.txt": "1" });
    const repoA = await ws.initRepo({ name: "a", identity: alice });
    const repoB = await ws.initRepo({ name: "b", identity: alice });
    const a = await ws.mirror({ repo: repoA, ref: MAIN, identity: alice, source: source(up) });
    // List repo A's branch in repo B.
    await ws.listBranch(repoB, alice, { ref: MAIN, delegate: alice.did, branch: a.branch });
    const report = await verifyRepository(await ws.package(repoB), { now: LATER });
    expect(report.branches[0].code?.history).toMatchObject({ status: "invalid", failure: { code: "BRANCH_REPO" } });
    expect(report.canonical[0]).toMatchObject({ status: "no-quorum", delegates: [{ status: "invalid" }] });
  });

  test("the repo author must stay a delegate: the writer refuses, the verifier rejects", async () => {
    const t = await twoDelegates(1);
    await expect(t.ws.updateRepo(t.repo, t.alice, (doc) => ({ ...doc, delegates: [t.bob.did], refs: {} }))).rejects.toMatchObject({ code: "REPO_AUTHOR" });
    // A writer that skips the check: still a valid Original, refused by the code profile.
    const { versionId } = await t.ws.repoDocument(t.repo);
    await t.ws.sdk.edit(t.repo, {
      parent: versionId,
      resource: { bytes: encodeRepoDocument({ delegates: [t.bob.did], refs: {}, grants: [] }), mediaType: REPO_MEDIA_TYPE },
      author: identityRef(t.alice),
      signer: keySigner({ keyType: "Ed25519", secretKey: t.alice.signingSecret, verificationMethod: identityRef(t.alice).verificationMethod }),
    });
    const r = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    expect(r.repo.report?.validAsOf).not.toBeNull();
    expect(r.repo.code?.history).toMatchObject({ status: "invalid", failure: { code: "REPO_AUTHOR" } });
    expect(r.canonicalStatus).toBe("invalid");
    expect(r.canonical).toEqual([]);
  });
});
