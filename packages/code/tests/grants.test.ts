/**
 * Phase 3: per-path grants (plan 049, K7; CODE-12 to CODE-16). A non-author
 * signer of a branch is an Originals editor (P5.15–P5.17) whose changes are
 * further bounded by the path grants of the repo version its entry names.
 * The writer refuses outside-grant changes before signing; the verifier
 * rejects them when a dishonest writer commits them anyway.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { signerOf, type EntryState } from "@originals/vh/originals";
import { GitSource } from "../src/git.js";
import { appendCommits, identityRef, identitySigner, verifyRepository, type LocalIdentity } from "../src/index.js";
import { FixtureRepo, NOW, identity, importRaw, logOf, workspace } from "./helpers.js";

const MAIN = "refs/heads/main";
const LATER = NOW + 3_600_000;
const EDIT = { name: false, metadata: true, resource: true };
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
function source(repo: FixtureRepo) {
  const s = new GitSource(repo.dir);
  cleanup.push(() => s.close());
  return s;
}

async function granted() {
  const alice = await identity(1);
  const carol = await identity(3);
  const dave = await identity(4);
  const ws = workspace();
  for (const id of [carol, dave]) ws.addIdentity(id);
  const up = new FixtureRepo();
  cleanup.push(() => up.remove());
  up.commit({ "packages/vh/a.ts": "a1", "packages/sdk/b.ts": "b1", "README.md": "r" });
  const repo = await ws.initRepo({ name: "grants", identity: alice });
  const { branch } = await ws.mirror({ repo, ref: MAIN, identity: alice, source: source(up) });
  await ws.updateRepo(repo, alice, (doc) => ({ ...doc, grants: [{ did: carol.did, paths: ["packages/vh/**"] }] }));
  await ws.grantEditors(branch, alice, [
    { did: carol.did, ...EDIT },
    { did: dave.did, ...EDIT },
  ].sort((x, y) => (x.did < y.did ? -1 : 1)));
  return { alice, carol, dave, ws, up, repo, branch };
}

/** Sign `commit` into the branch as `who` with no path check, and commit it as a dishonest writer would. */
async function forceEditorEntry(t: Awaited<ReturnType<typeof granted>>, who: LocalIdentity, commit: string, role: "author" | "editor" = "editor", repoVersion?: string) {
  const log = await logOf(t.ws, t.branch);
  const converted = await source(t.up).convert(commit, t.ws.objects);
  const version = repoVersion ?? (await t.ws.repoDocument(t.repo)).versionId;
  const entries = await appendCommits({ log, commits: [converted], repo: t.repo, ref: MAIN, repoVersion: version, signer: { role, ref: identityRef(who), sign: identitySigner(who) }, clock: () => Date.parse(log[log.length - 1].versionTime) + 1000 });
  const all = [...log, ...entries];
  const signers = new Set(all.map((e) => signerOf(e.state as unknown as EntryState).ref.did));
  const { result } = await importRaw(t.ws, all, [t.alice, t.carol, t.dave].filter((x) => signers.has(x.did)), t.branch);
  expect(result.status).toBe("imported"); // a valid originals:1.0 Original: the editor grant allows it (P5.16)
}

describe("CODE-12 a covered change", () => {
  test("an editor's commit inside its path grant is accepted and counts toward the canonical head", async () => {
    const t = await granted();
    const c = t.up.commit({ "packages/vh/a.ts": "a2", "packages/vh/new/deep.ts": "d" });
    const r = await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.carol, source: source(t.up), branch: t.branch });
    expect(r).toMatchObject({ created: false, appended: 1, head: { commit: c } });
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    const b = report.branches[0].code!;
    expect(b.history.status).toBe("valid");
    expect(b.grants).toEqual([{ versionId: r.head.versionId, signer: t.carol.did, status: "allowed", touched: 2 }]);
    expect(b.historicallyAuthorizedOnly).toEqual([]);
    expect(report.canonical[0]).toMatchObject({ status: "agreed", head: { commit: c } });
  });
});

describe("CODE-13 a change outside the grant", () => {
  test("the writer refuses before signing; the branch is unchanged", async () => {
    const t = await granted();
    const before = (await t.ws.sdk.get(t.branch)).checkpoint;
    t.up.commit({ "packages/vh/a.ts": "a2", "packages/sdk/b.ts": "b2" });
    await expect(t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.carol, source: source(t.up), branch: t.branch })).rejects.toMatchObject({
      category: "outside-grant",
      code: "OUTSIDE_PATH_GRANT",
      details: { outside: ["packages/sdk/b.ts"] },
    });
    expect((await t.ws.sdk.get(t.branch)).checkpoint).toBe(before);
  });

  test("a rename into the grant touches the old path too; a deletion outside counts", async () => {
    const t = await granted();
    t.up.git("mv", "packages/sdk/b.ts", "packages/vh/b.ts");
    t.up.git("commit", "-q", "-m", "move");
    await expect(t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.carol, source: source(t.up), branch: t.branch })).rejects.toMatchObject({ details: { outside: ["packages/sdk/b.ts"] } });
    const u = new FixtureRepo(t.up);
    cleanup.push(() => u.remove());
    u.git("reset", "-q", "--hard", "HEAD~1");
    u.commit({ "README.md": null });
    await expect(t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.carol, source: source(u), branch: t.branch })).rejects.toMatchObject({ details: { outside: ["README.md"] } });
  });

  test("the verifier rejects one a dishonest writer committed, naming the paths", async () => {
    const t = await granted();
    const c = t.up.commit({ "packages/vh/a.ts": "a2", "packages/sdk/b.ts": "b2" });
    await forceEditorEntry(t, t.carol, c);
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    const b = report.branches[0];
    expect(b.report?.validAsOf).not.toBeNull(); // the Originals result is separate and unchanged
    expect(b.code?.history).toMatchObject({ status: "invalid", failure: { code: "OUTSIDE_PATH_GRANT" } });
    expect(b.code?.grants.at(-1)).toMatchObject({ signer: t.carol.did, status: "outside-grant", outside: ["packages/sdk/b.ts"] });
    expect(report.canonical[0]).toMatchObject({ status: "no-quorum", head: null, delegates: [{ status: "invalid" }] });
  });
});

describe("CODE-14 an editor with no path grant", () => {
  test("is refused by the writer and rejected by the verifier", async () => {
    const t = await granted();
    const c = t.up.commit({ "packages/vh/a.ts": "a2" });
    await expect(t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.dave, source: source(t.up), branch: t.branch })).rejects.toMatchObject({ category: "outside-grant", code: "NO_PATH_GRANT" });
    await forceEditorEntry(t, t.dave, c);
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    expect(report.branches[0].code?.history).toMatchObject({ status: "invalid", failure: { code: "NO_PATH_GRANT" } });
  });
});

describe("CODE-15 a grant narrowed later", () => {
  test("keeps the entry valid and reports it historically authorized only (P7.9 by analogy)", async () => {
    const t = await granted();
    t.up.commit({ "packages/vh/a.ts": "a2" });
    const r = await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.carol, source: source(t.up), branch: t.branch });
    await t.ws.updateRepo(t.repo, t.alice, (doc) => ({ ...doc, grants: [] }));
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    const b = report.branches[0].code!;
    expect(b.history.status).toBe("valid");
    expect(b.historicallyAuthorizedOnly).toEqual([{ versionId: r.head.versionId, signer: t.carol.did, reason: "path-grant-narrowed" }]);
    expect(report.canonical[0].status).toBe("agreed");
  });
});

describe("CODE-16 repoVersion never goes backwards", () => {
  test("an entry naming an older repo version than its parent is rejected", async () => {
    const t = await granted();
    t.up.commit({ "packages/vh/a.ts": "a2" });
    await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.carol, source: source(t.up), branch: t.branch });
    const genesisRepoVersion = (await logOf(t.ws, t.repo))[0].versionId;
    const c = t.up.commit({ "README.md": "r2" });
    await forceEditorEntry(t, t.alice, c, "author", genesisRepoVersion);
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    expect(report.branches[0].code?.history).toMatchObject({ status: "invalid", failure: { code: "REPO_VERSION_BACKWARDS" } });
  });
});
