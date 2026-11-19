/**
 * Repo governance in profile 0.2 (plan 049 K5 and K17, revised for plan 050
 * W1; CODE-29 to CODE-32). The repo Original is a set Original whose members
 * are the delegates: every member signs its genesis (P5.19), and each later
 * change is an author entry signed by the threshold of the set before it, and
 * by every member it adds (P5.20). Members who are not together sign a
 * proposal file in turn (P5.22). The release Original carries the repo's set
 * at the repo version each entry pins (K17).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { GitSource } from "../src/git.js";
import { parseProposal, serializeProposal, verifyRepository } from "../src/index.js";
import { FixtureRepo, NOW, identity, logOf, workspace } from "./helpers.js";

const MAIN = "refs/heads/main";
const LATER = { now: NOW + 3_600_000 };
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
function source(repo: FixtureRepo) {
  const s = new GitSource(repo.dir);
  cleanup.push(() => s.close());
  return s;
}

/** Alice, Bob and Carol govern a repo, threshold 2; Alice mirrors main and two of them list it. */
async function threeDelegates() {
  const [alice, bob, carol, dave] = await Promise.all([identity(1), identity(2), identity(3), identity(4)]);
  const ws = workspace();
  for (const id of [bob, carol, dave]) ws.addIdentity(id);
  const up = new FixtureRepo();
  cleanup.push(() => up.remove());
  const c1 = up.commit({ "a.txt": "1" });
  const repo = await ws.initRepo({ name: "three", identity: alice, delegates: [bob, carol], threshold: 2 });
  const m = await ws.mirror({ repo, ref: MAIN, identity: alice, source: source(up) });
  // At threshold 2 no delegate lists its branch alone (P5.20): a repo change two of them sign.
  expect(m.needsListing).toBe(true);
  await ws.listBranch(repo, [alice, carol], { ref: MAIN, delegate: alice.did, branch: m.branch });
  return { alice, bob, carol, dave, ws, up, repo, branch: m.branch, c1 };
}

describe("CODE-29 a repo governed by a signer set (P5.19, P5.20)", () => {
  test("three delegates, threshold 2: every member signs genesis; the report gives the set; a change signed by two of three verifies", async () => {
    const t = await threeDelegates();
    const report = await verifyRepository(await t.ws.package(t.repo), LATER);
    const dids = [t.alice.did, t.bob.did, t.carol.did].sort();
    expect(report.repo.report?.signedBy[0]).toEqual({ versionId: expect.any(String), role: "author", dids });
    expect(report.repo.report?.signedBy[1].dids).toEqual([t.alice.did, t.carol.did].sort());
    expect(report.repo.code).toMatchObject({ history: { status: "valid" }, authors: { threshold: 2, dids }, document: { delegates: dids } });
    expect(report.repo.report?.document?.controller).toEqual(dids);
    expect(report.canonical[0]).toMatchObject({ status: "agreed", head: { commit: t.c1 } });
  });

  test("a change signed by one of three is refused and nothing is committed", async () => {
    const t = await threeDelegates();
    const before = (await t.ws.repoDocument(t.repo)).versionId;
    await expect(t.ws.updateRepo(t.repo, t.alice, (doc) => ({ ...doc, refs: { [MAIN]: { ...doc.refs[MAIN], threshold: 1 } } }))).rejects.toMatchObject({ code: "AUTHORS_THRESHOLD_NOT_MET" });
    expect((await t.ws.repoDocument(t.repo)).versionId).toBe(before);
  });

  test("a delegate change with 2 of 3 signatures: Dave joins (and signs), Carol leaves; with 1 it is refused", async () => {
    const t = await threeDelegates();
    const next = (doc: { delegates: string[] }) => [...doc.delegates.filter((d) => d !== t.carol.did), t.dave.did].sort();
    // One member and the new one: below the threshold of the set before (P5.20).
    await expect(t.ws.updateRepo(t.repo, [t.alice, t.dave], (doc) => ({ ...doc, delegates: next(doc) }))).rejects.toMatchObject({ code: "AUTHORS_THRESHOLD_NOT_MET" });
    // Two members but not the one added: refused before anyone signs.
    await expect(t.ws.updateRepo(t.repo, [t.alice, t.bob], (doc) => ({ ...doc, delegates: next(doc) }))).rejects.toMatchObject({ code: "AUTHORS_MEMBER_NOT_SIGNED" });
    await t.ws.updateRepo(t.repo, [t.alice, t.bob, t.dave], (doc) => ({ ...doc, delegates: next(doc) }));
    const report = await verifyRepository(await t.ws.package(t.repo), LATER);
    expect(report.repo.code).toMatchObject({ history: { status: "valid" }, authors: { threshold: 2, dids: [t.alice.did, t.bob.did, t.dave.did].sort() } });
    // Carol is no longer a member: she and Dave together cannot meet a threshold she is not part of.
    await expect(t.ws.updateRepo(t.repo, [t.carol, t.dave], (doc) => doc)).rejects.toMatchObject({ code: expect.stringMatching(/SIGNER_NOT_MEMBER|AUTHORS_THRESHOLD_NOT_MET/) });
  });
});

describe("CODE-30 proposals: members who are not together sign in turn (P5.22)", () => {
  test("propose → cosign → cosign → commit, through the proposal file; commit before the last signature is refused", async () => {
    const t = await threeDelegates();
    const draft = await t.ws.proposeRepo(t.repo, [t.bob.did, t.carol.did], (s) => ({ ...s, threshold: 3 }));
    expect(draft.display).toContain("Signer set");
    let file = serializeProposal(draft);
    file = serializeProposal(await t.ws.cosignRepo(parseProposal(file), t.carol));
    expect(parseProposal(file).proofs).toHaveLength(1);
    await expect(t.ws.commitRepo(parseProposal(file))).rejects.toThrow();
    // Someone the proposal does not name cannot sign it.
    await expect(t.ws.cosignRepo(parseProposal(file), t.alice)).rejects.toMatchObject({ code: "SIGNER_NOT_NAMED" });
    file = serializeProposal(await t.ws.cosignRepo(parseProposal(file), t.bob));
    const checkpoint = await t.ws.commitRepo(parseProposal(file));
    expect((await t.ws.repoState(t.repo)).threshold).toBe(3);
    expect((await logOf(t.ws, t.repo)).at(-1)?.versionId).toBe(checkpoint);
  });

  test("a proposal whose repo moved on is stale: refused, never rebased (P4.5)", async () => {
    const t = await threeDelegates();
    const draft = await t.ws.proposeRepo(t.repo, [t.alice.did, t.bob.did], (s) => ({ ...s, threshold: 1 }));
    await t.ws.updateRepo(t.repo, [t.alice, t.carol], (doc) => ({ ...doc, refs: { [MAIN]: { ...doc.refs[MAIN], threshold: 2 } } }));
    await expect(t.ws.cosignRepo(draft, t.alice)).rejects.toMatchObject({ category: "stale-parent" });
  });

  test("a proposal file that is not one is refused", () => {
    expect(() => parseProposal(JSON.stringify({ format: "something/else" }))).toThrow(expect.objectContaining({ code: "PROPOSAL_FILE" }));
  });
});

describe("CODE-31 the release Original carries the repo's signer set (K17)", () => {
  test("the first release is signed by every delegate; later ones by the threshold; a delegate change reaches it with the next release", async () => {
    const t = await threeDelegates();
    // Creating it is a set Original's genesis: every member signs (P5.19).
    await expect(t.ws.release(t.repo, [t.alice, t.bob], { tag: "v1" })).rejects.toMatchObject({ code: "AUTHORS_MEMBER_NOT_SIGNED" });
    const r1 = await t.ws.release(t.repo, [t.alice, t.bob, t.carol], { tag: "v1" });
    expect(r1.created).toBe(true);
    const c2 = t.up.commit({ "a.txt": "2" });
    await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.alice, source: source(t.up) });
    await expect(t.ws.release(t.repo, t.alice, { tag: "v2" })).rejects.toMatchObject({ code: "AUTHORS_THRESHOLD_NOT_MET" });
    await t.ws.release(t.repo, [t.alice, t.carol], { tag: "v2" });
    // Dave replaces Carol in the repo; the next release pins that version and carries the new set. It is
    // signed by the threshold of the release set before it, Dave's signature not counting (P5.20), and by Dave.
    await t.ws.updateRepo(t.repo, [t.alice, t.bob, t.dave], (doc) => ({ ...doc, delegates: [...doc.delegates.filter((d) => d !== t.carol.did), t.dave.did].sort() }));
    await expect(t.ws.release(t.repo, [t.alice, t.dave], { tag: "v3", commit: c2 })).rejects.toMatchObject({ code: "AUTHORS_THRESHOLD_NOT_MET" });
    const r3 = await t.ws.release(t.repo, [t.alice, t.bob, t.dave], { tag: "v3", commit: c2 });
    expect(r3.created).toBe(false);
    const report = await verifyRepository(await t.ws.package(t.repo), LATER);
    const rel = report.releases!;
    expect(rel.report?.validAsOf).not.toBeNull();
    expect(rel.code).toMatchObject({ history: { status: "valid" }, authors: { threshold: 2, dids: [t.alice.did, t.bob.did, t.dave.did].sort() } });
    expect(rel.code!.releases.map((x) => [x.tag, x.chain])).toEqual([["v1", "in-chain"], ["v2", "in-chain"], ["v3", "in-chain"]]);
  });

  test("a release Original whose set differs from the repo's at its pin fails the release history", async () => {
    const t = await threeDelegates();
    const r1 = await t.ws.release(t.repo, [t.alice, t.bob, t.carol], { tag: "v1" });
    // The release set changes without the repo: two of three drop Carol from releases alone.
    const view = await t.ws.sdk.get(r1.releases);
    const { keySigner } = await import("@originals/sdk/originals");
    const { SIGNING_FRAGMENT, identityRef } = await import("../src/index.js");
    const sign = (id: typeof t.alice) => keySigner({ keyType: "Ed25519", secretKey: id.signingSecret, verificationMethod: `${id.did}#${SIGNING_FRAGMENT}` });
    await t.ws.sdk.edit(r1.releases, { parent: view.checkpoint, name: "renamed", authors: { threshold: 2, dids: [t.alice.did, t.bob.did].sort() }, author: [identityRef(t.alice), identityRef(t.bob)], signers: [sign(t.alice), sign(t.bob)] });
    const report = await verifyRepository(await t.ws.package(t.repo), LATER);
    expect(report.releases!.report?.validAsOf).not.toBeNull(); // a valid Original; the code rule is what fails
    expect(report.releases!.code!.history).toMatchObject({ status: "invalid", failure: { code: "RELEASES_AUTHORS" } });
  });
});

describe("CODE-32 every branch inherits the repo's grants (P5.24)", () => {
  test("a grant made once in the repo lets an editor write into two delegates' branches, with no grant in either", async () => {
    const t = await threeDelegates();
    const bobUp = new FixtureRepo(t.up);
    cleanup.push(() => bobUp.remove());
    const b = await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.bob, source: source(bobUp) });
    await t.ws.listBranch(t.repo, [t.alice, t.bob], { ref: MAIN, delegate: t.bob.did, branch: b.branch });
    await t.ws.grantPaths(t.repo, [t.alice, t.bob], t.dave.did, ["docs/**"]);
    t.up.commit({ "docs/x.md": "x" });
    bobUp.commit({ "docs/y.md": "y" });
    await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.dave, source: source(t.up), branch: t.branch });
    await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.dave, source: source(bobUp), branch: b.branch });
    const report = await verifyRepository(await t.ws.package(t.repo), LATER);
    for (const branch of report.branches) {
      expect(branch.code?.history.status).toBe("valid");
      expect(branch.code?.grants).toEqual([expect.objectContaining({ signer: t.dave.did, status: "allowed", source: "inherited", scope: { type: "paths", status: "checked" } })]);
    }
    // P5.15: a repo grant may not name a delegate, since editors and members are disjoint.
    await expect(t.ws.grantPaths(t.repo, [t.alice, t.bob], t.carol.did, ["**"])).rejects.toMatchObject({ code: "STATE_EDITORS" });
  });
});
