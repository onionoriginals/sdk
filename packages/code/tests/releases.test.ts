/**
 * The release Original (plan 049 §6, decided 2026-11-19; PROVISIONAL K15;
 * CODE-25, CODE-26): the repo document names a release Original, authored by
 * the repo's author for now; each entry names one release (tag, commit, the
 * branch Original and entry, and the canonical result at the time) as a
 * small JSON manifest. The verifier checks each release's commit is in the
 * named branch's chain. Network is disabled for every test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MemoryStore } from "@originals/sdk/originals";
import { GitSource } from "../src/git.js";
import { CodeWorkspace, MemoryObjectStore, RELEASE_MEDIA_TYPE, decodeReleaseManifest, encodeReleaseManifest, identityRef, readBundle, verifyRepository, writeBundle, type ReleaseManifest } from "../src/index.js";
import { FixtureRepo, NOW, identity, ticking, workspace } from "./helpers.js";

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

async function mirrored(ws = workspace(), n = 3) {
  const alice = await identity(1);
  const repo = new FixtureRepo();
  cleanup.push(() => repo.remove());
  const commits: string[] = [];
  for (let i = 0; i < n; i++) commits.push(repo.commit({ "a.txt": `${i}\n` }));
  const repoDid = await ws.initRepo({ name: "rel", identity: alice });
  const m = await ws.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: source(repo) });
  return { alice, ws, repo, repoDid, commits, branch: m.branch };
}

/** Sign a release entry directly, as a dishonest or buggy writer would. */
async function rawRelease(ws: CodeWorkspace, releases: string, alice: Awaited<ReturnType<typeof identity>>, manifest: ReleaseManifest) {
  const view = await ws.sdk.get(releases);
  const { keySigner } = await import("@originals/sdk/originals");
  const { SIGNING_FRAGMENT } = await import("../src/index.js");
  await ws.sdk.edit(releases, {
    parent: view.checkpoint,
    resource: { mediaType: RELEASE_MEDIA_TYPE, bytes: encodeReleaseManifest(manifest) },
    author: identityRef(alice),
    signer: keySigner({ keyType: "Ed25519", secretKey: alice.signingSecret, verificationMethod: `${alice.did}#${SIGNING_FRAGMENT}` }),
  });
}

describe("CODE-25 the release Original", () => {
  test("a release names the canonical head, its branch entry and the canonical result; the verifier finds it in the chain", async () => {
    const { alice, ws, repo, repoDid, commits, branch } = await mirrored();
    const r1 = await ws.release(repoDid, alice, { tag: "v1.0.0" });
    expect(r1.created).toBe(true);
    expect(r1.manifest).toMatchObject({ tag: "v1.0.0", ref: MAIN, commit: commits[2], branch, canonical: { status: "agreed", head: commits[2], threshold: 1, votes: [alice.did] } });
    expect((await ws.repoDocument(repoDid)).document.releases).toBe(r1.releases);

    commits.push(repo.commit({ "a.txt": "later\n" }));
    await ws.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: source(repo) });
    const r2 = await ws.release(repoDid, alice, { tag: "v1.1.0" });
    expect(r2).toMatchObject({ created: false, releases: r1.releases, manifest: { commit: commits[3] } });
    // An older commit can be released by name.
    const r3 = await ws.release(repoDid, alice, { tag: "v0.9.0", commit: commits[0] });
    expect(r3.manifest).toMatchObject({ commit: commits[0], canonical: { head: commits[3] } });
    await expect(ws.release(repoDid, alice, { tag: "v1.0.0" })).rejects.toMatchObject({ code: "RELEASE_TAG_EXISTS" });

    const report = await verifyRepository(await ws.package(repoDid), later);
    expect(report.branches).toHaveLength(1); // the release Original is not a branch
    const rel = report.releases!;
    expect(rel.report?.validAsOf).not.toBeNull();
    expect(rel.code).toMatchObject({ history: { status: "valid" }, binding: "confirmed", author: alice.did });
    expect(rel.code!.releases.map((x) => [x.tag, x.commit, x.chain])).toEqual([
      ["v1.0.0", commits[2], "in-chain"],
      ["v1.1.0", commits[3], "in-chain"],
      ["v0.9.0", commits[0], "in-chain"],
    ]);
    expect(report.current).toBe(false);
  });

  test("a release in an earlier segment names that segment", async () => {
    const ws = CodeWorkspace.create({ originals: new MemoryStore(), objects: new MemoryObjectStore(), clock: ticking(), segmentEntries: 2 });
    const { alice, repoDid, commits } = await mirrored(ws, 5);
    const r = await ws.release(repoDid, alice, { tag: "old", commit: commits[1] });
    const { document } = await ws.repoDocument(repoDid);
    expect(r.manifest.branch).not.toBe(document.refs[MAIN].branches[alice.did]);
    const report = await verifyRepository(await ws.package(repoDid), later);
    expect(report.releases!.code!.releases[0]).toMatchObject({ branch: r.manifest.branch, chain: "in-chain" });
  });

  test("only the repo's author releases; a commit outside every listed chain is refused", async () => {
    const { ws, repoDid } = await mirrored();
    const bob = await identity(2);
    await expect(ws.release(repoDid, bob, { tag: "v1" })).rejects.toMatchObject({ code: "RELEASE_AUTHOR" });
    const { alice } = { alice: await identity(1) };
    await expect(ws.release(repoDid, alice, { tag: "v1", commit: "f".repeat(40) })).rejects.toMatchObject({ code: "RELEASE_NOT_IN_CHAIN" });
    await expect(ws.release(repoDid, alice, { tag: "bad..tag" })).rejects.toMatchObject({ code: "RELEASE_TAG" });
  });

  test("a release manifest is strict JCS", () => {
    const m: ReleaseManifest = { tag: "v1", ref: MAIN, commit: "a".repeat(40), branch: "did:vh:QmA", versionId: "1-QmA", canonical: { status: "agreed", head: "a".repeat(40), threshold: 1, votes: ["did:vh:QmB"] } };
    const bytes = encodeReleaseManifest(m);
    expect(decodeReleaseManifest(bytes)).toMatchObject(m);
    const spaced = new TextEncoder().encode(new TextDecoder().decode(bytes).replace(":", ": "));
    expect(() => decodeReleaseManifest(spaced)).toThrow();
  });
});

describe("CODE-26 release failures", () => {
  test("a release naming a commit not at the named entry fails the release history", async () => {
    const { alice, ws, repoDid, commits, branch } = await mirrored();
    const r = await ws.release(repoDid, alice, { tag: "v1" });
    const chain = (await verifyRepository(await ws.package(repoDid), later)).branches[0].code!.chain;
    await rawRelease(ws, r.releases, alice, { ...r.manifest, tag: "v2", commit: commits[0], versionId: chain[2].versionId, branch });
    const report = await verifyRepository(await ws.package(repoDid), later);
    expect(report.releases!.report?.validAsOf).not.toBeNull(); // a valid Original; the code claim is what fails
    expect(report.releases!.code!.history).toMatchObject({ status: "invalid", failure: { code: "RELEASE_NOT_IN_CHAIN", index: 1 } });
  });

  test("a tag released twice fails the release history", async () => {
    const { alice, ws, repoDid, commits } = await mirrored();
    const r = await ws.release(repoDid, alice, { tag: "v1" });
    const chain = (await verifyRepository(await ws.package(repoDid), later)).branches[0].code!.chain;
    await rawRelease(ws, r.releases, alice, { ...r.manifest, commit: commits[1], versionId: chain[1].versionId });
    const report = await verifyRepository(await ws.package(repoDid), later);
    expect(report.releases!.code!.history).toMatchObject({ status: "invalid", failure: { code: "RELEASE_TAG_REPEATED" } });
  });

  test("a release whose branch is not in the evidence is incomplete, never a pass", async () => {
    const { alice, ws, repoDid, branch } = await mirrored();
    await ws.release(repoDid, alice, { tag: "v1" });
    const contents = await readBundle(await ws.package(repoDid));
    const bundle = writeBundle({ repo: contents.manifest.repo, checkpoint: contents.manifest.checkpoint, packages: contents.packages.filter((p) => p.original !== branch), objects: contents.objects.entries() });
    const report = await verifyRepository(bundle, later);
    expect(report.releases!.code!.releases[0].chain).toBe("branch-missing");
    expect(report.releases!.code!.history.status).toBe("incomplete");
  });
});
