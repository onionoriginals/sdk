/**
 * Editors through the SDK (P5.11, P5.15-P5.18, P6.6, P7.1, P7.8): the author
 * grants and revokes; an editor signs through the normal edit API with its
 * own DID; packages carry every signer's DID history; the signer is shown who
 * signs. Grant member names are PROVISIONAL (D4).
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { resourceDigest, type EditorGrant } from "@originals/vh/originals";
import { didWebvhLogUrl } from "@originals/vh/webvh";
import {
  MemoryStore,
  OriginalsSDK,
  authorPath,
  describeEntry,
  keySigner,
  readZip,
  writeZip,
  type HostedFetch,
  type OriginalsSigner,
  type SigningRequest,
} from "../../../src/originals/index.js";
import { Author, WebvhIdentity, bytes, clock, seed } from "./helpers.js";

const B1 = bytes("harbor at dawn, first crop");
const B2 = bytes("harbor at dawn, Bob's crop");
const B3 = bytes("harbor at dawn, Bob's second crop");
const KA = seed(21);
const KB = seed(31);
const KC = seed(32);

const grant = (did: string, g: Partial<Omit<EditorGrant, "did">> = {}): EditorGrant => ({ did, name: false, metadata: false, resources: [], ...g });

async function rejects(promise: Promise<unknown>, category: string, code?: string) {
  const caught = await promise.then(() => undefined, (e: unknown) => e);
  expect(caught, "expected a rejection").toBeInstanceOf(OriginalsError);
  expect((caught as OriginalsError).category).toBe(category as never);
  if (code) expect((caught as OriginalsError).code).toBe(code);
}

/** Alice grants Bob `resources: ["photo"]` and Carol `metadata: true` at genesis. */
async function harbor() {
  const alice = await Author.create([{ fragment: "orig", secret: KA }]);
  const bob = await Author.create([{ fragment: "edit", secret: KB }]);
  const carol = await Author.create([{ fragment: "edit", secret: KC }]);
  const dids = [alice, bob, carol];
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: async (did) => dids.find((d) => d.did === did)?.evidence(), clock: clock() });
  const created = await sdk.create({
    name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }],
    author: alice.ref("orig"), signer: alice.signer("orig", KA),
    editors: [grant(bob.did, { resources: ["photo"] }), grant(carol.did, { metadata: true })],
  });
  if (created.kind !== "original") throw new Error("expected an Original");
  const asBob = { editor: bob.ref("edit"), signer: bob.signer("edit", KB) };
  const asCarol = { editor: carol.ref("edit"), signer: carol.signer("edit", KC) };
  const asAlice = { author: alice.ref("orig"), signer: alice.signer("orig", KA) };
  return { alice, bob, carol, store, sdk, did: created.original.did, v1: created.original.checkpoint, asBob, asCarol, asAlice };
}

describe("C12-113: editors sign through the normal edit API", () => {
  test("Bob replaces the photo, Carol corrects the caption; neither is countersigned and the author is unchanged", async () => {
    const { alice, bob, carol, sdk, did, v1, asBob, asCarol } = await harbor();
    const byBob = await sdk.edit(did, { parent: v1, resources: [{ id: "photo", bytes: B2 }], ...asBob });
    const byCarol = await sdk.edit(did, { parent: byBob.original.checkpoint, metadata: { caption: "Corrected caption" }, ...asCarol });
    const view = byCarol.original;
    expect(view.report.reasons).toEqual(["not-anchored"]);
    expect(view.report.identityEvidence.author).toBe(alice.did);
    expect(view.report.identityEvidence.editors.map((e) => [e.did, e.status, e.freshness])).toEqual([[bob.did, "complete", "not-established"], [carol.did, "complete", "not-established"]]);
    expect(view.state.metadata).toEqual({ caption: "Corrected caption" });
    expect(view.resources.map((r) => [r.version, r.digest])).toEqual([[1, resourceDigest(B1)], [2, resourceDigest(B2)]]);
  });

  test("the store retains the highest versionId it verified for each signer (P7.8)", async () => {
    const { alice, bob, store, sdk, did, v1, asBob } = await harbor();
    await sdk.edit(did, { parent: v1, resources: [{ id: "photo", bytes: B2 }], ...asBob });
    expect(await store.getRetained(bob.did)).toBe(bob.versionId);
    expect(await store.getRetained(alice.did)).toBe(alice.versionId);
  });
});

describe("C12-114, C12-115: an editor's change outside its grant is refused before anything is signed", () => {
  test("outside the grant, changing grants or deactivating is refused, and the signer is never asked", async () => {
    const { bob, sdk, did, v1, asBob } = await harbor();
    let asked = 0;
    const watching: OriginalsSigner = { ...asBob.signer, sign: (r) => (asked++, asBob.signer.sign(r)) };
    await rejects(sdk.edit(did, { parent: v1, name: "Bob's harbor", editor: asBob.editor, signer: watching }), "outside-grant", "EDITOR_OUTSIDE_GRANT");
    await rejects(sdk.edit(did, { parent: v1, metadata: { caption: "x" }, editor: asBob.editor, signer: watching }), "outside-grant", "EDITOR_OUTSIDE_GRANT");
    await rejects(sdk.edit(did, { parent: v1, editors: [grant(bob.did, { name: true, resources: ["photo"] })], editor: asBob.editor, signer: watching }), "outside-grant", "EDITOR_AUTHOR_ONLY");
    await rejects(sdk.deactivate(did, { parent: v1, editor: asBob.editor, signer: watching } as never), "invalid-evidence", "INPUT_INVALID");
    expect(asked).toBe(0);
    expect((await sdk.get(did)).checkpoint).toBe(v1);
  });
});

describe("C12-117, C12-119: the author grants, narrows and revokes", () => {
  test("a revoked editor's next change is refused; its earlier entries stay valid", async () => {
    const { carol, sdk, did, v1, asBob, asAlice } = await harbor();
    const byBob = await sdk.edit(did, { parent: v1, resources: [{ id: "photo", bytes: B2 }], ...asBob });
    const revoked = await sdk.edit(did, { parent: byBob.original.checkpoint, editors: [grant(carol.did, { metadata: true })], ...asAlice });
    expect(revoked.original.state.editors).toEqual([grant(carol.did, { metadata: true })]);
    await rejects(sdk.edit(did, { parent: revoked.original.checkpoint, resources: [{ id: "photo", bytes: B3 }], ...asBob }), "unauthorized-key", "EDITOR_NOT_GRANTED");
    const view = await sdk.get(did);
    expect(view.report.reasons).toEqual(["not-anchored"]);
    expect(view.resources.at(-1)?.versionId).toBe(byBob.original.checkpoint);
    const none = await sdk.edit(did, { parent: revoked.original.checkpoint, editors: null, ...asAlice });
    expect(none.original.state.editors).toBeUndefined();
  });
});

describe("C12-124 and P7.1: evidence packages carry every signer's DID history", () => {
  test("a complete package includes the editors' histories; a fresh reader verifies with no source of its own", async () => {
    const { bob, carol, sdk, did, v1, asBob } = await harbor();
    await sdk.edit(did, { parent: v1, resources: [{ id: "photo", bytes: B2 }], ...asBob });
    const pkg = await sdk.package(did);
    expect(pkg.manifest).toMatchObject({ completeness: "complete", missing: [] });
    const files = readZip(pkg.bytes);
    expect(files.has(`${authorPath(bob.did)}/did.jsonl`)).toBe(true);
    // Carol signed nothing, so her history is not needed (P7.1).
    expect(files.has(`${authorPath(carol.did)}/did.jsonl`)).toBe(false);
    const fresh = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const loaded = await fresh.load(pkg.bytes);
    expect(loaded.report.identityEvidence).toMatchObject({ status: "complete" });
    expect(loaded.report.identityEvidence.editors.map((e) => [e.did, e.status])).toEqual([[bob.did, "complete"]]);
    expect(loaded.reasons).not.toContain("manifest-completeness-mismatch");
  });

  test("without the editor's history the result is incomplete identity evidence and not current", async () => {
    const { bob, sdk, did, v1, asBob } = await harbor();
    await sdk.edit(did, { parent: v1, resources: [{ id: "photo", bytes: B2 }], ...asBob });
    const files = new Map([...readZip((await sdk.package(did)).bytes)].filter(([path]) => !path.startsWith(`${authorPath(bob.did)}/`)));
    const manifest = JSON.parse(new TextDecoder().decode(files.get("originals-evidence.json"))) as Record<string, unknown>;
    files.set("originals-evidence.json", new TextEncoder().encode(JSON.stringify({ ...manifest, completeness: "partial", missing: [{ kind: "identity", did: bob.did, role: "editor" }] })));
    const fresh = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const loaded = await fresh.load(writeZip(files));
    expect(loaded.report.history.failure?.code).toBe("EDITOR_HISTORY_MISSING");
    expect(loaded.report.identityEvidence.status).toBe("incomplete");
    expect(loaded.report.identityEvidence.editors).toEqual([expect.objectContaining({ did: bob.did, status: "incomplete" })]);
    expect(loaded.report.current).toBe(false);
    expect(loaded.reasons).not.toContain("manifest-completeness-mismatch");
  });
});

describe("signing (P5.11): the signer is shown who signs", () => {
  test("an editor's request names the editor as signer, and the display text says so", async () => {
    const { alice, bob, sdk, did, v1, asBob } = await harbor();
    const seen: SigningRequest[] = [];
    const watching: OriginalsSigner = { ...asBob.signer, sign: (r) => (seen.push(r), asBob.signer.sign(r)) };
    await sdk.edit(did, { parent: v1, resources: [{ id: "photo", bytes: B2 }], editor: asBob.editor, signer: watching });
    expect(seen[0].summary.signer).toEqual({ role: "editor", ...bob.ref("edit") });
    expect(seen[0].summary.author).toEqual(alice.ref("orig"));
    expect(seen[0].display).toBe(describeEntry(seen[0].summary));
    expect(seen[0].display).toContain(`Signing as editor ${bob.did}`);
    expect(seen[0].display).toContain(`Author: ${alice.did}`);
    expect(seen[0].display).toContain(`photo: ${resourceDigest(B1)} -> ${resourceDigest(B2)}`);
    const authorText = describeEntry({ ...seen[0].summary, signer: { role: "author", ...alice.ref("orig") } });
    expect(authorText).toContain(`Signing as author ${alice.did}`);
  });

  test("keySigner shows the text to `confirm`, refuses when declined, and refuses a summary that misstates the entry", async () => {
    const { bob, sdk, did, v1, asBob } = await harbor();
    const shown: string[] = [];
    const declining = keySigner({ keyType: "Ed25519", secretKey: KB, verificationMethod: asBob.editor.verificationMethod, confirm: (text) => (shown.push(text), false) });
    await rejects(sdk.edit(did, { parent: v1, resources: [{ id: "photo", bytes: B2 }], editor: asBob.editor, signer: declining }), "invalid-evidence", "SIGNER_REFUSED");
    expect(shown[0]).toContain(`Signing as editor ${bob.did}`);
    // A request whose summary names someone else as signer is refused.
    const draft = await sdk.prepareEdit(did, { parent: v1, resources: [{ id: "photo", bytes: B2 }], editor: asBob.editor });
    const proofOptions = { type: "DataIntegrityProof" as const, cryptosuite: "eddsa-jcs-2022" as const, verificationMethod: asBob.editor.verificationMethod, proofPurpose: "assertionMethod" };
    const lying = { ...draft.summary, signer: { ...draft.summary.signer, role: "author" as const } };
    await rejects(asBob.signer.sign({ entry: draft.entry, proofOptions, summary: lying, display: describeEntry(lying) }), "invalid-evidence", "SIGNER_REFUSED");
    // Bob's key does not sign an author entry naming Alice's key, nor an editor entry naming another editor key.
    const asAuthor = keySigner({ keyType: "Ed25519", secretKey: KB, verificationMethod: draft.summary.author.verificationMethod });
    await rejects(asAuthor.sign({ entry: draft.entry, proofOptions: { ...proofOptions, verificationMethod: asAuthor.verificationMethod }, summary: draft.summary, display: draft.display }), "invalid-evidence", "SIGNER_REFUSED");
  });
});

describe("signing (P5.11): keySigner shows what the entry itself says (editors PR review A3)", () => {
  const proofFor = (verificationMethod: string) => ({ type: "DataIntegrityProof" as const, cryptosuite: "eddsa-jcs-2022" as const, verificationMethod, proofPurpose: "assertionMethod" });

  test("a summary that hides a grant change, a rename or a metadata change is refused", async () => {
    const { sdk, did, v1, asAlice, store } = await harbor();
    const parent = { entry: JSON.parse((await store.get(did))!.log.trimEnd().split("\n")[0]) as never };
    const mallory = await Author.create([{ fragment: "edit", secret: seed(66) }]);
    const draft = await sdk.prepareEdit(did, { parent: v1, author: asAlice.author, name: "Harbor (fixed typo)", metadata: { note: "x" }, editors: [grant(mallory.did, { name: true, metadata: true, resources: ["photo"] })] });
    let shown = "";
    const signer = keySigner({ keyType: "Ed25519", secretKey: KA, verificationMethod: asAlice.author.verificationMethod, confirm: (text) => ((shown = text), true) });
    for (const lie of [{ editorsChanged: false }, { nameChanged: false, name: "Harbor at dawn" }, { metadataChanged: false }]) {
      const lying = { ...draft.summary, ...lie };
      await rejects(signer.sign({ entry: draft.entry, proofOptions: proofFor(asAlice.author.verificationMethod), summary: lying, display: describeEntry(lying), parent }), "invalid-evidence", "SIGNER_REFUSED");
    }
    expect(shown).toBe("");
    // The true summary with the same parent signs.
    await signer.sign({ entry: draft.entry, proofOptions: proofFor(asAlice.author.verificationMethod), summary: draft.summary, display: draft.display, parent });
    expect(shown).toContain("Editor grants: changed");
  });

  test("the text shown is derived from the entry and its parent, with each grant's DID and rights", async () => {
    const { sdk, did, v1, asAlice } = await harbor();
    const mallory = await Author.create([{ fragment: "edit", secret: seed(66) }]);
    let shown = "";
    const signer = keySigner({ keyType: "Ed25519", secretKey: KA, verificationMethod: asAlice.author.verificationMethod, confirm: (text) => ((shown = text), true) });
    await sdk.edit(did, { parent: v1, author: asAlice.author, editors: [grant(mallory.did, { name: true, metadata: true, resources: ["photo"] })], signer });
    expect(shown).toContain("Editor grants: changed");
    expect(shown).toContain(`${mallory.did}: name yes, metadata yes, resources photo`);
    expect(shown).not.toContain("Name: changed");
  });

  test("a parent that does not chain to the entry is refused; without one, every change is shown", async () => {
    const { sdk, did, v1, asAlice, store } = await harbor();
    const mallory = await Author.create([{ fragment: "edit", secret: seed(66) }]);
    const draft = await sdk.prepareEdit(did, { parent: v1, author: asAlice.author, editors: [grant(mallory.did, { resources: ["photo"] })] });
    const genesis = JSON.parse((await store.get(did))!.log.trimEnd().split("\n")[0]) as Record<string, any>;
    const forgedParent = { ...genesis, state: { ...genesis.state, asset: { ...genesis.state.asset, editors: [grant(mallory.did, { resources: ["photo"] })] } } };
    let shown = "";
    const signer = keySigner({ keyType: "Ed25519", secretKey: KA, verificationMethod: asAlice.author.verificationMethod, confirm: (text) => ((shown = text), true) });
    const request = { entry: draft.entry, proofOptions: proofFor(asAlice.author.verificationMethod), summary: { ...draft.summary, editorsChanged: false }, display: "" };
    await rejects(signer.sign({ ...request, parent: { entry: forgedParent as never } }), "invalid-evidence", "SIGNER_REFUSED");
    // With no parent the signer cannot tell what changed, so it shows the name, metadata and every grant.
    await signer.sign({ ...request, summary: draft.summary });
    expect(shown).toContain("Editor grants:");
    expect(shown).toContain(`${mallory.did}: name no, metadata no, resources photo`);
  });
});

describe("C12-118: an editor entry and a revoking author entry on the same parent", () => {
  test("are a fork, reported with both branches and never current (P5.17, P6.6)", async () => {
    const { alice, bob, carol, sdk, did, v1, asBob, asAlice } = await harbor();
    const dids = [alice, bob, carol];
    // Bob works from a copy of v1 on his own machine.
    const bobs = OriginalsSDK.create({ store: new MemoryStore(), authors: async (d) => dids.find((x) => x.did === d)?.evidence(), clock: clock() });
    await bobs.import((await sdk.package(did)).bytes);
    const byBob = await bobs.edit(did, { parent: v1, resources: [{ id: "photo", bytes: B2 }], ...asBob });
    // Meanwhile Alice revokes Bob on the same parent.
    const revoke = await sdk.edit(did, { parent: v1, editors: [grant(carol.did, { metadata: true })], ...asAlice });
    const result = await sdk.import((await bobs.package(did)).bytes);
    expect(result.status).toBe("conflict");
    const view = await sdk.get(did);
    expect(view.report.fork?.branches.map((b) => b.versionId).sort()).toEqual([byBob.original.checkpoint, revoke.original.checkpoint].sort());
    expect(view.current).toBe(false);
  });
});

describe("C12-134: a moved author whose latest asset entry is an editor entry, read by a fresh reader", () => {
  test("author freshness is not established: the editor entry does not reveal where the author moved", async () => {
    const alice = await WebvhIdentity.create("old.example.com", [{ fragment: "orig-1", secret: KA }]);
    const bob = await Author.create([{ fragment: "edit", secret: KB }]);
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async (d) => (d === alice.did ? alice.evidence() : d === bob.did ? bob.evidence() : undefined), clock: clock() });
    const ref = alice.ref("orig-1");
    const created = await sdk.create({ name: "Harbor", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author: ref, signer: alice.signer(ref, KA), editors: [grant(bob.did, { resources: ["photo"] })] });
    if (created.kind !== "original") throw new Error("expected an Original");
    await alice.move("new.example.org");
    await alice.rotate([{ fragment: "orig-2", secret: seed(22) }]);
    await sdk.edit(created.original.did, { parent: created.original.checkpoint, resources: [{ id: "photo", bytes: B2 }], editor: bob.ref("edit"), signer: bob.signer("edit", KB) });
    const pkg = await sdk.package(created.original.did);
    // Alice's log is served where she now is; the asset log only says where she was.
    const served: Record<string, string> = { [didWebvhLogUrl(alice.location)]: alice.evidence().log as string };
    const seen: string[] = [];
    const fetcher: HostedFetch = (url) => {
      seen.push(url);
      return served[url] === undefined ? Promise.reject(new OriginalsError("unavailable-bytes", "FETCH_STATUS", "404")) : Promise.resolve(new TextEncoder().encode(served[url]));
    };
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], identityFetch: fetcher, clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const r = (await reader.load(pkg.bytes)).report;
    expect(seen[0]).toBe(didWebvhLogUrl(alice.did));
    expect(seen).not.toContain(didWebvhLogUrl(alice.location));
    expect(r.history.status).toBe("valid");
    expect(r.identityEvidence.freshness).toBe("not-established");
    expect(r.current).toBe(false);
  });
});
