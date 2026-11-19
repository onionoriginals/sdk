/**
 * Path grants in profile 0.2 (plan 049 K7, revised for plan 050 W2/W3;
 * CODE-12 to CODE-16). A path grant is an editor grant in the repo
 * Original's `editors` with a `paths` scope (P5.15, P5.28, P14.23); every
 * branch, a child of the repo, inherits it at the repo version its entry pins
 * (P5.24). The core decides the grant and the scope; the code report restates
 * the result per entry. The writer refuses outside-grant changes before
 * signing; a dishonest writer's entry is rejected by the Originals verifier
 * itself, and its branch never votes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeEvidence } from "@originals/sdk/originals";
import { serializeLog, type LogEntry } from "@originals/vh/log";
import { signerOf, type EntryState } from "@originals/vh/originals";
import { GitSource } from "../src/git.js";
import { appendCommits, identityEvidence, identityRef, identitySigner, readBundle, readTree, verifyRepository, writeBundle, type LocalIdentity } from "../src/index.js";
import { FixtureRepo, NOW, identity, logOf, workspace } from "./helpers.js";

const MAIN = "refs/heads/main";
const LATER = NOW + 3_600_000;
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
function source(repo: FixtureRepo) {
  const s = new GitSource(repo.dir);
  cleanup.push(() => s.close());
  return s;
}

/** Alice's repo grants Carol `packages/vh/**`; Dave holds no grant. Alice mirrors main. */
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
  const grantVersion = await ws.grantPaths(repo, alice, carol.did, ["packages/vh/**"]);
  return { alice, carol, dave, ws, up, repo, branch, grantVersion };
}

/** Every tree object under `root`, the root included. */
async function trees(t: Awaited<ReturnType<typeof granted>>, root: string, out = new Map<string, Uint8Array>()): Promise<Map<string, Uint8Array>> {
  const bytes = (await t.ws.objects.get(root)) ?? (await t.ws.sdk.resourceBytes(root))!;
  out.set(root, bytes);
  for (const e of Object.values((await readTree(root, () => bytes)).entries)) if (e.mode === "40000") await trees(t, e.digest, out);
  return out;
}

/**
 * Sign `commit` into the branch as `who` with no path check, as a dishonest
 * writer would, and put that log in a bundle in place of the honest branch,
 * with the repo log and every tree the core's scope check reads (P5.25, P7.1).
 */
async function forcedBundle(t: Awaited<ReturnType<typeof granted>>, who: LocalIdentity, commit: string, role: "author" | "editor" = "editor", pin?: string): Promise<Uint8Array> {
  const log = await logOf(t.ws, t.branch);
  const converted = await source(t.up).convert(commit, t.ws.objects);
  const at = pin ?? (await t.ws.repoDocument(t.repo)).versionId;
  const grant = role === "editor" ? (await t.ws.repoState(t.repo)).editors.find((g) => g.did === who.did) : undefined;
  let entries: LogEntry[];
  try {
    entries = await appendCommits({ log, commits: [converted], repo: t.repo, ref: MAIN, pin: at, signer: { role, ref: identityRef(who), sign: identitySigner(who) }, ...(grant ? { inherited: grant } : {}), clock: () => Date.parse(log[log.length - 1].versionTime) + 1000 });
  } catch {
    // The builder refuses what the state rules refuse (no grant at all): sign the entry around it.
    const { prepareUpdateOriginal } = await import("@originals/vh/originals");
    const { signEntry } = await import("@originals/vh/log");
    const prev = log[log.length - 1];
    const meta = { code: { ...((prev.state as unknown as EntryState).asset.metadata as { code: object }).code, commit: converted.commit, tree: converted.tree, ...(converted.object ? { commitObject: converted.object } : {}) } };
    const unsigned = prepareUpdateOriginal(prev, { versionTime: new Date(Date.parse(prev.versionTime) + 1000).toISOString(), metadata: meta, resource: { mediaType: "application/vnd.originals.code-tree+json", size: converted.root.size, digest: converted.root.digest }, author: identityRef(t.alice), inherited: { did: who.did, name: false, metadata: true, resource: true } , editor: identityRef(who) } as never);
    entries = [await signEntry(unsigned, identitySigner(who))];
  }
  const all = [...log, ...entries];
  const bytes: Record<string, Uint8Array> = {};
  for (const e of all) for (const [d, b] of await trees(t, (e.state as unknown as EntryState).asset.resource.digest)) bytes[d] = b;
  const signers = new Set(all.map((e) => signerOf(e.state as unknown as EntryState).ref.did));
  const last = all[all.length - 1].versionId;
  const zip = writeEvidence({
    manifest: { format: "originals-evidence/0.1", profile: "originals:1.0", original: t.branch, checkpoint: last, head: last, completeness: "complete", missing: [] },
    log: serializeLog(all),
    authors: [t.alice, t.carol, t.dave].filter((x) => signers.has(x.did) || x === t.alice).map((x) => identityEvidence(x)),
    bytes,
    parents: [{ did: t.repo, log: (await t.ws.originals.get(t.repo))!.log }],
  });
  const contents = await readBundle(await t.ws.package(t.repo));
  return writeBundle({
    repo: contents.manifest.repo,
    checkpoint: contents.manifest.checkpoint,
    packages: [...contents.packages.filter((p) => p.original !== t.branch), { original: t.branch, checkpoint: last, bytes: zip }],
    objects: contents.objects.entries(),
  });
}

describe("CODE-12 a covered change (P5.24, P5.28)", () => {
  test("an editor inheriting packages/vh/** from the repo commits inside it; the core checks the scope, and the branch counts toward the canonical head", async () => {
    const t = await granted();
    const c = t.up.commit({ "packages/vh/a.ts": "a2", "packages/vh/new/deep.ts": "d" });
    const r = await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.carol, source: source(t.up), branch: t.branch });
    expect(r).toMatchObject({ created: false, appended: 1, head: { commit: c } });
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    const b = report.branches[0].code!;
    expect(b.history.status).toBe("valid");
    // No grant in the branch itself: the repo's, inherited at the pin (P5.24), its scope checked by the core (P5.28).
    expect(b.grants).toEqual([{ versionId: r.head.versionId, signer: t.carol.did, status: "allowed", touched: 2, source: "inherited", pin: t.grantVersion, scope: { type: "paths", status: "checked" } }]);
    expect(report.branches[0].report?.grants).toEqual([{ versionId: r.head.versionId, editor: t.carol.did, source: "inherited", parent: { did: t.repo, versionId: t.grantVersion }, scope: { type: "paths", status: "checked" } }]);
    expect(report.branches[0].report?.parentAuthority).toMatchObject({ did: t.repo, status: "verified" });
    expect(report.repo.code?.grants).toEqual([{ did: t.carol.did, paths: ["packages/vh/**"] }]);
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

  test("the Originals verifier rejects one a dishonest writer signed, naming the paths; the branch does not vote", async () => {
    const t = await granted();
    const c = t.up.commit({ "packages/vh/a.ts": "a2", "packages/sdk/b.ts": "b2" });
    const report = await verifyRepository(await forcedBundle(t, t.carol, c), { now: LATER });
    const b = report.branches[0];
    // P5.28: outside the scope is rejected by the core, not by a code-profile rule.
    expect(b.packages[0]).toMatchObject({ history: "invalid" });
    expect(b.report?.history.failure ?? b.error).toMatchObject({ code: "SCOPE_OUTSIDE" });
    expect(report.canonical[0]).toMatchObject({ status: "no-quorum", head: null, delegates: [{ status: "invalid" }] });
  });
});

describe("CODE-14 an editor with no path grant", () => {
  test("is refused by the writer and rejected by the Originals verifier (P5.16, P5.24)", async () => {
    const t = await granted();
    const c = t.up.commit({ "packages/vh/a.ts": "a2" });
    await expect(t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.dave, source: source(t.up), branch: t.branch })).rejects.toMatchObject({ category: "outside-grant", code: "NO_PATH_GRANT" });
    const report = await verifyRepository(await forcedBundle(t, t.dave, c), { now: LATER });
    const b = report.branches[0];
    expect(b.report?.history.failure ?? b.error).toMatchObject({ code: "EDITOR_NOT_GRANTED" });
    expect(report.canonical[0]).toMatchObject({ status: "no-quorum", head: null, delegates: [{ status: "invalid" }] });
  });
});

describe("CODE-15 a grant revoked later (P5.26)", () => {
  test("keeps the entry valid and reports it historically authorized only, from the core's report; a new entry under it is refused", async () => {
    const t = await granted();
    t.up.commit({ "packages/vh/a.ts": "a2" });
    const r = await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.carol, source: source(t.up), branch: t.branch });
    await t.ws.grantPaths(t.repo, t.alice, t.carol.did, null);
    const report = await verifyRepository(await t.ws.package(t.repo), { now: LATER });
    const b = report.branches[0];
    expect(b.code?.history.status).toBe("valid");
    expect(b.report?.historicallyAuthorizedOnly).toEqual([expect.objectContaining({ versionId: r.head.versionId, did: t.carol.did, role: "editor", reason: "inherited-grant-revoked", parent: { did: t.repo, versionId: t.grantVersion } })]);
    expect(b.code?.historicallyAuthorizedOnly).toEqual([{ versionId: r.head.versionId, signer: t.carol.did, reason: "inherited-grant-revoked", pin: t.grantVersion }]);
    expect(report.canonical[0].status).toBe("agreed");
    // Writing again pins the revocation, where Carol has no grant: refused before signing.
    t.up.commit({ "packages/vh/a.ts": "a3" });
    await expect(t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.carol, source: source(t.up), branch: t.branch })).rejects.toMatchObject({ code: "NO_PATH_GRANT" });
  });
});

describe("CODE-16 the pin never goes backwards (P5.24)", () => {
  test("an entry pinning an older repo version than its parent is rejected by the core", async () => {
    const t = await granted();
    t.up.commit({ "packages/vh/a.ts": "a2" });
    await t.ws.mirror({ repo: t.repo, ref: MAIN, identity: t.carol, source: source(t.up), branch: t.branch });
    const genesisRepoVersion = (await logOf(t.ws, t.repo))[0].versionId;
    const c = t.up.commit({ "README.md": "r2" });
    const report = await verifyRepository(await forcedBundle(t, t.alice, c, "author", genesisRepoVersion), { now: LATER });
    const b = report.branches[0];
    expect(b.report?.history.failure ?? b.error).toMatchObject({ code: "PARENT_PIN_BACKWARDS" });
    expect(report.canonical[0]).toMatchObject({ status: "no-quorum", head: null });
  });
});
