/**
 * Parent Originals through the SDK (P5.24–P5.27; originals-spec #66, owner
 * decision of 19 November 2026): `create({ parent })`, `edit({ pin })`, which
 * by default advances to the newest parent version held, an editor relying on
 * an inherited grant, and evidence packages that carry the parent's log
 * through the highest pin (P5.25, P7.1, P14.10).
 *
 * Rows C12-398, C12-400, C12-401 and C12-411.
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { MemoryStore, OriginalsSDK, keySigner, readZip, writeZip, type OriginalsSigner } from "../../../src/originals/index.js";
import { parentPath, readEvidence, signerPath } from "../../../src/originals/evidence.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const P1 = bytes("repository, first tree");
const C1 = bytes("branch, first tree");
const C2 = bytes("branch, docs changed");

async function rejects(promise: Promise<unknown>, category: string, code?: string) {
  const caught = await promise.then(() => undefined, (e: unknown) => e);
  expect(caught, "expected a rejection").toBeInstanceOf(OriginalsError);
  expect((caught as OriginalsError).category, (caught as Error).message).toBe(category as never);
  if (code) expect((caught as OriginalsError).code, (caught as Error).message).toBe(code);
}

/** Alice's repository grants Dana the resource; Bob's branch names it as its parent. */
async function repository() {
  const keys = [seed(21), seed(31), seed(41)];
  const [alice, bob, dana] = await Promise.all(keys.map((k) => Author.create([{ fragment: "orig", secret: k }])));
  const signer = (a: Author, k: Uint8Array): OriginalsSigner => keySigner({ keyType: "Ed25519", secretKey: k, verificationMethod: `${a.did}#orig` });
  const [asAlice, asBob, asDana] = [signer(alice, keys[0]), signer(bob, keys[1]), signer(dana, keys[2])];
  const all = [alice, bob, dana];
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: async (did) => all.find((d) => d.did === did)?.evidence(), clock: clock() });
  const created = await sdk.create({ name: "Repository", resource: { mediaType: "application/octet-stream", bytes: P1 }, author: alice.ref("orig"), signer: asAlice });
  if (created.kind !== "original") throw new Error("expected an Original");
  const repo = created.original.did;
  const granted = await sdk.edit(repo, { parent: created.original.checkpoint, editors: [{ did: dana.did, name: false, metadata: false, resource: true }], author: alice.ref("orig"), signer: asAlice });
  const pin = granted.original.checkpoint;
  const branch = await sdk.create({ name: "Branch", resource: { mediaType: "application/octet-stream", bytes: C1 }, author: bob.ref("orig"), signer: asBob, parent: { did: repo, versionId: pin } });
  if (branch.kind !== "original") throw new Error("expected an Original");
  return { alice, bob, dana, asAlice, asBob, asDana, sdk, store, all, repo, pin, branch: branch.original.did, b1: branch.original.checkpoint };
}

describe("C12-398 (P5.24): create a child, and edit it under an inherited grant", () => {
  test("the child names its parent and pin; Dana edits it with the grant she holds in the parent", async () => {
    const { dana, asDana, sdk, repo, pin, branch, b1 } = await repository();
    const view = await sdk.get(branch);
    expect(view.state.parent).toEqual({ did: repo, versionId: pin });
    expect(view.report.parentAuthority).toMatchObject({ did: repo, status: "verified", pins: [pin] });
    const edited = await sdk.edit(branch, { parent: b1, resource: { bytes: C2 }, editor: dana.ref("orig"), signer: asDana });
    expect(edited.original.report.grants).toEqual([{ versionId: edited.original.checkpoint, editor: dana.did, source: "inherited", parent: { did: repo, versionId: pin } }]);
    expect(edited.original.report.history.status).toBe("valid");
  });
});

describe("C12-400 (P5.24): the pin advances, never back", () => {
  test("by default an edit pins the newest parent version held; a revocation there leaves the editor with no grant", async () => {
    const { alice, bob, dana, asAlice, asBob, asDana, sdk, repo, pin, branch, b1 } = await repository();
    const revoked = await sdk.edit(repo, { parent: pin, editors: null, author: alice.ref("orig"), signer: asAlice });
    // Dana's edit now pins the revocation, where she has no grant: refused before signing.
    await rejects(sdk.edit(branch, { parent: b1, resource: { bytes: C2 }, editor: dana.ref("orig"), signer: asDana }), "unauthorized-key", "EDITOR_NOT_GRANTED");
    // Pinning the earlier version explicitly, she still can; the entry is historically authorized only (P5.26).
    const old = await sdk.edit(branch, { parent: b1, resource: { bytes: C2 }, pin, editor: dana.ref("orig"), signer: asDana });
    expect(old.original.report.historicallyAuthorizedOnly.map((h) => h.reason)).toEqual(["inherited-grant-revoked"]);
    // Bob's next edit advances the pin to the revocation by default.
    const byBob = await sdk.edit(branch, { parent: old.original.checkpoint, name: "Branch, renamed", author: bob.ref("orig"), signer: asBob });
    expect(byBob.original.state.parent?.versionId).toBe(revoked.original.checkpoint);
    // Going back is refused by the verifier, so never committed.
    await rejects(sdk.edit(branch, { parent: byBob.original.checkpoint, name: "Branch, back", pin, author: bob.ref("orig"), signer: asBob }), "invalid-evidence", "PARENT_PIN_BACKWARDS");
    expect((await sdk.get(branch)).checkpoint).toBe(byBob.original.checkpoint);
  });
});

describe("C12-401, C12-411 (P5.25, P7.1, P14.10): evidence packages carry the parent's log", () => {
  test("a package includes the parent's log through the highest pin, and its signers; a fresh reader verifies it", async () => {
    const { alice, dana, asAlice, asDana, sdk, repo, pin, branch, b1 } = await repository();
    await sdk.edit(repo, { parent: pin, name: "Repository, later", author: alice.ref("orig"), signer: asAlice });
    await sdk.edit(branch, { parent: b1, resource: { bytes: C2 }, pin, editor: dana.ref("orig"), signer: asDana });
    const pkg = await sdk.package(branch);
    expect(pkg.manifest.completeness).toBe("complete");
    const files = readZip(pkg.bytes);
    const parentLog = new TextDecoder().decode(files.get(`${parentPath(repo)}/did.jsonl`)!);
    // Through the pin, not the parent's later head.
    expect(parentLog.trimEnd().split("\n").map((l) => JSON.parse(l).versionId)).toEqual([expect.any(String), pin]);
    expect(files.has(`${signerPath(alice.did)}/did.jsonl`)).toBe(true);
    expect(readEvidence(pkg.bytes).parents?.map((p) => p.did)).toEqual([repo]);
    // A fresh reader with no store and no author source verifies the child from the package alone.
    const fresh = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock() });
    const loaded = await fresh.load(pkg.bytes);
    expect(loaded.report.history.status).toBe("valid");
    expect(loaded.report.parentAuthority).toMatchObject({ did: repo, status: "verified" });
    expect(loaded.reasons).not.toContain("manifest-completeness-mismatch");
    // Importing keeps the parent's log too.
    const imported = await fresh.import(pkg.bytes);
    expect(imported.status).toBe("imported");
    expect(await fresh.get(branch)).toMatchObject({ did: branch });
  });

  test("C12-411: a package that omits the parent's log is partial, with a `parent` missing item; a reader reports the child incomplete", async () => {
    const { alice, repo, pin, branch, sdk } = await repository();
    const files = new Map(readZip((await sdk.package(branch)).bytes));
    files.delete(`${parentPath(repo)}/did.jsonl`);
    files.delete(`${signerPath(alice.did)}/did.jsonl`);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("originals-evidence.json")!));
    const fresh = () => OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock() });
    // Still claiming complete: the reader finds it is not.
    const claimed = await fresh().load(writeZip(files));
    expect(claimed.report.history.status).toBe("incomplete");
    expect(claimed.report.history.failure?.code).toBe("PARENT_EVIDENCE_MISSING");
    expect(claimed.report.parentAuthority).toMatchObject({ did: repo, status: "missing" });
    expect(claimed.reasons).toContain("manifest-completeness-mismatch");
    // Declared partial, listing the parent through the pin: the manifest is honest, the child still incomplete.
    files.set("originals-evidence.json", new TextEncoder().encode(JSON.stringify({ ...manifest, completeness: "partial", missing: [{ kind: "parent", did: repo, versionId: pin }] })));
    const honest = await fresh().load(writeZip(files));
    expect(honest.manifest.missing).toEqual([{ kind: "parent", did: repo, versionId: pin }]);
    expect(honest.reasons).not.toContain("manifest-completeness-mismatch");
    expect(honest.report.validAsOf).toBeNull();
  });

  test("a packager that does not hold the parent cannot verify the child, so it packages nothing", async () => {
    const { branch, store, sdk } = await repository();
    const partial = new MemoryStore();
    await partial.commit(branch, { expectedHead: null, log: (await store.get(branch))!.log });
    const keepAuthors = (sdk as unknown as { options: { authors: unknown } }).options.authors;
    const packager = OriginalsSDK.create({ store: partial, authors: keepAuthors as never, clock: clock() });
    await rejects(packager.package(branch), "incomplete-evidence", "ORIGINAL_NOT_VERIFIED");
  });
});
