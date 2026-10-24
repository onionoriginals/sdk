/**
 * Resource-set changes (originals-spec #49; P4.1, P4.4, P5.15, P5.16, P14.4,
 * P14.5). Genesis establishes at least one resource. An author entry may add
 * resources, appended after the existing ones, and remove resources while one
 * remains; an editor entry may do neither. A resourceID is never used again in
 * an Original, even after its resource is removed. A removed resource's
 * earlier versions stay verifiable, and an added one starts at version 1.
 */
import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../src/json/index.js";
import { appendEntry, type LogEntry } from "../src/log/index.js";
import {
  createOriginal,
  resourceDigest,
  updateOriginal,
  verifyOriginal,
  type EditorGrant,
  type OriginalsReport,
} from "../src/originals/index.js";
import { NOW, VhAuthor, bytes, clock, photo, seeded } from "./helpers/originals.js";

const B1 = "harbor at dawn, first crop";
const B2 = "harbor at dawn, tighter crop";
const N1 = "a note about the harbor";
const N2 = "a longer note about the harbor";
const S1 = "harbor sketch";
const texts = [B1, B2, N1, N2, S1];
const allBytes = Object.fromEntries(texts.map((t) => [resourceDigest(bytes(t)), bytes(t)]));
const note = (text: string, id = "note") => ({ id, mediaType: "text/plain", size: bytes(text).length, digest: resourceDigest(bytes(text)) });
const KA = seeded(21);
const KB = seeded(31);

const grant = (did: string, g: Partial<Omit<EditorGrant, "did">> = {}): EditorGrant => ({ did, name: false, metadata: false, resources: [], ...g });

async function harbor(editors?: (bob: VhAuthor) => EditorGrant[]) {
  const alice = await VhAuthor.create([{ fragment: "orig", signer: KA }]);
  const bob = await VhAuthor.create([{ fragment: "edit", signer: KB }]);
  const at = clock();
  const ref = alice.ref("orig");
  const sign = alice.signer(KA, "orig");
  const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dawn", resources: [photo(B1)], author: ref, sign, ...(editors ? { editors: editors(bob) } : {}) });
  const asAlice = { author: ref, sign };
  const asBob = { editor: bob.ref("edit"), sign: bob.signer(KB, "edit") };
  return { alice, bob, at, ref, sign, genesis, asAlice, asBob };
}

const verify = (log: LogEntry[], dids: VhAuthor[]): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors: dids.map((a) => a.evidence()), now: NOW, bytes: allBytes });

function failedWith(r: OriginalsReport, index: number, code: string, category?: string) {
  expect(r.history.failure?.index, JSON.stringify(r.history.failure)).toBe(index);
  expect(r.history.failure?.code).toBe(code);
  if (category) expect(r.history.failure?.category).toBe(category);
  expect(r.history.entries).toBe(index);
}

/** Sign an edited state after `previous`, bypassing the builder's checks. */
const forge = (previous: LogEntry, state: JsonObject, sign: Parameters<typeof appendEntry>[1]["sign"], parameters: JsonObject = {}) =>
  appendEntry(previous, { versionTime: "2026-10-18T12:30:00.000Z", parameters, state, sign });

const assetOf = (entry: LogEntry) => entry.state.asset as JsonObject;

describe("C12-16: a resource added or removed by an author entry", () => {
  test("is accepted; the added resource is at version 1 and the removed one stays verifiable in history (P4.1, P4.4)", async () => {
    const { alice, at, genesis, asAlice } = await harbor();
    const added = await updateOriginal(genesis, { versionTime: at(), resources: [note(N1)], ...asAlice });
    expect((added.state.asset as { resources: Array<{ id: string }> }).resources.map((r) => r.id)).toEqual(["photo", "note"]);
    const edited = await updateOriginal(added, { versionTime: at(), resources: [photo(B2), note(N2)], ...asAlice });
    const removed = await updateOriginal(edited, { versionTime: at(), remove: ["photo"], ...asAlice });
    expect((removed.state.asset as { resources: Array<{ id: string }> }).resources.map((r) => r.id)).toEqual(["note"]);
    const r = await verify([genesis, added, edited, removed], [alice]);
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.authorBinding.status).toBe("valid");
    expect(r.state?.resources.map((d) => d.id)).toEqual(["note"]);
    // Versions come from history: note starts at 1 when added; photo's versions stay, verified (P4.4, P8.3).
    expect(r.resources.versions.map((v) => [v.resource, v.version, v.versionId, v.bytes])).toEqual([
      ["photo", 1, genesis.versionId, "verified"],
      ["note", 1, added.versionId, "verified"],
      ["photo", 2, edited.versionId, "verified"],
      ["note", 2, edited.versionId, "verified"],
    ]);
    expect(r.resources.status).toBe("available");
    // The derived document lists the current resources only (P3.8).
    expect(Object.keys((r.document?.service as Array<{ serviceEndpoint: JsonObject }>)[0].serviceEndpoint)).toEqual(["note"]);
    // An earlier checkpoint still verifies with the removed resource in it.
    const earlier = await verifyOriginal({ log: [genesis, added, edited, removed], authors: [alice.evidence()], now: NOW, bytes: allBytes, checkpoint: edited.versionId });
    expect(earlier.state?.resources.map((d) => d.id)).toEqual(["photo", "note"]);
    // Bytes of a removed resource's earlier versions are still checked: a wrong one is a digest failure.
    const wrong = await verifyOriginal({ log: [genesis, added, edited, removed], authors: [alice.evidence()], now: NOW, bytes: { ...allBytes, [photo(B2).digest]: bytes("not the crop") } });
    expect(wrong.resources.status).toBe("digest-failure");
    expect(wrong.resources.failures.map((v) => [v.resource, v.version])).toEqual([["photo", 2]]);
  });

  test("added resources are appended in order, and existing resources keep theirs (P14.5)", async () => {
    const { alice, at, genesis, asAlice } = await harbor();
    const two = await updateOriginal(genesis, { versionTime: at(), resources: [note(N1), note(S1, "sketch")], ...asAlice });
    expect((two.state.asset as { resources: Array<{ id: string }> }).resources.map((r) => r.id)).toEqual(["photo", "note", "sketch"]);
    expect((await verify([genesis, two], [alice])).history.status).toBe("valid");
    // A forged entry that reorders the existing resources, or puts an added one before them, is rejected.
    const asset = assetOf(two);
    for (const resources of [[note(N1), photo(B1), note(S1, "sketch")], [photo(B1), note(S1, "sketch"), note(N1)]]) {
      const reordered = await forge(two, { ...two.state, asset: { ...asset, resources }, transitions: [] }, asAlice.sign);
      failedWith(await verify([genesis, two, reordered], [alice]), 2, "STATE_RESOURCE_SET", "invalid-evidence");
    }
    const first = await forge(genesis, {
      ...genesis.state, operation: "update", asset: { ...assetOf(genesis), resources: [note(N1), photo(B1)] },
      transitions: [{ resource: "note", from: null, to: note(N1).digest }],
    }, asAlice.sign);
    failedWith(await verify([genesis, first], [alice]), 1, "STATE_RESOURCE_SET", "invalid-evidence");
  });

  test("there is no rename: a new id with the old bytes is a removal and an addition (P4.1)", async () => {
    const { alice, at, genesis, asAlice } = await harbor();
    const renamed = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B1, "image")], remove: ["photo"], ...asAlice });
    expect(renamed.state.transitions).toEqual([
      { resource: "image", from: null, to: photo(B1).digest },
      { resource: "photo", from: photo(B1).digest, to: null },
    ]);
    const r = await verify([genesis, renamed], [alice]);
    expect(r.history.status).toBe("valid");
    expect(r.resources.versions.map((v) => [v.resource, v.version])).toEqual([["photo", 1], ["image", 1]]);
  });
});

describe("C12-154: an editor entry that adds or removes a resource, even one its grant names", () => {
  test("is rejected as outside the grant: only an author entry may (P5.16)", async () => {
    const { alice, bob, at, genesis, asAlice, asBob } = await harbor((bob) => [grant(bob.did, { resources: ["photo"] })]);
    // The builder refuses before anything is signed.
    await expect(updateOriginal(genesis, { versionTime: at(), resources: [note(N1)], ...asBob })).rejects.toMatchObject({ category: "outside-grant", code: "EDITOR_AUTHOR_ONLY" });
    // The author adds note and grants it to Bob; Bob still cannot remove it.
    const withNote = await updateOriginal(genesis, { versionTime: at(), resources: [note(N1)], editors: [grant(bob.did, { resources: ["photo", "note"] })], ...asAlice });
    await expect(updateOriginal(withNote, { versionTime: at(), remove: ["note"], ...asBob })).rejects.toMatchObject({ category: "outside-grant", code: "EDITOR_AUTHOR_ONLY" });
    // Forged editor entries with valid proofs are rejected by the verifier.
    const adding = await forge(genesis, {
      ...genesis.state, operation: "update", editor: bob.ref("edit"),
      asset: { ...assetOf(genesis), resources: [photo(B1), note(N1)] }, transitions: [{ resource: "note", from: null, to: note(N1).digest }],
    }, asBob.sign);
    failedWith(await verify([genesis, adding], [alice, bob]), 1, "EDITOR_AUTHOR_ONLY", "outside-grant");
    // Removing note would leave a grant naming it; the grant is the author's, so narrow it too.
    const removing = await forge(withNote, {
      ...withNote.state, operation: "update", editor: bob.ref("edit"),
      asset: { ...assetOf(withNote), resources: [photo(B1)], editors: [grant(bob.did, { resources: ["photo"] })] }, transitions: [{ resource: "note", from: note(N1).digest, to: null }],
    }, asBob.sign);
    failedWith(await verify([genesis, withNote, removing], [alice, bob]), 2, "EDITOR_AUTHOR_ONLY", "outside-grant");
    // Changing a granted resource's bytes is still the editor's to do.
    const byBob = await updateOriginal(withNote, { versionTime: at(), resources: [note(N2)], ...asBob });
    expect((await verify([genesis, withNote, byBob], [alice, bob])).history.status).toBe("valid");
  });
});

describe("C12-155: an entry that adds a resource with a resourceID the Original used before", () => {
  test("is rejected, even after the resource was removed (P4.1)", async () => {
    const { alice, at, genesis, asAlice } = await harbor();
    const withNote = await updateOriginal(genesis, { versionTime: at(), resources: [note(N1)], ...asAlice });
    const removed = await updateOriginal(withNote, { versionTime: at(), remove: ["note"], ...asAlice });
    // The builder refuses when it is told the ids the Original has used.
    await expect(updateOriginal(removed, { versionTime: at(), resources: [note(N2)], usedResourceIds: ["photo", "note"], ...asAlice })).rejects.toMatchObject({ category: "invalid-evidence", code: "STATE_RESOURCE_REUSED" });
    // The verifier knows the whole history, so a reuse fails wherever it was built.
    const reused = await updateOriginal(removed, { versionTime: at(), resources: [note(N2)], ...asAlice });
    const r = await verify([genesis, withNote, removed, reused], [alice]);
    failedWith(r, 3, "STATE_RESOURCE_REUSED", "invalid-evidence");
    expect(r.checkpoint).toBe(removed.versionId);
  });
});

describe("C12-156: an entry that removes the last resource", () => {
  test("is rejected: at least one resource remains (P4.1)", async () => {
    const { alice, at, genesis, asAlice } = await harbor();
    await expect(updateOriginal(genesis, { versionTime: at(), remove: ["photo"], ...asAlice })).rejects.toMatchObject({ category: "invalid-evidence", code: "STATE_RESOURCE_SET" });
    const emptied = await forge(genesis, {
      ...genesis.state, operation: "update", asset: { ...assetOf(genesis), resources: [] }, transitions: [{ resource: "photo", from: photo(B1).digest, to: null }],
    }, asAlice.sign);
    failedWith(await verify([genesis, emptied], [alice]), 1, "STATE_RESOURCE_SET", "invalid-evidence");
    // Removing an id that is not in the resource set is refused by the builder too.
    await expect(updateOriginal(genesis, { versionTime: at(), remove: ["note"], ...asAlice })).rejects.toMatchObject({ code: "STATE_RESOURCE_SET" });
  });
});

describe("C12-157: an author entry removing a resource that a grant still names", () => {
  test("is rejected; removing it from every grant in the same entry is accepted (P5.15)", async () => {
    const { alice, bob, at, genesis, asAlice } = await harbor((bob) => [grant(bob.did, { name: true, resources: ["photo"] })]);
    const withNote = await updateOriginal(genesis, { versionTime: at(), resources: [note(N1)], ...asAlice });
    await expect(updateOriginal(withNote, { versionTime: at(), remove: ["photo"], ...asAlice })).rejects.toMatchObject({ category: "invalid-evidence", code: "STATE_EDITORS" });
    const stillGranted = await forge(withNote, {
      ...withNote.state, operation: "update", asset: { ...assetOf(withNote), resources: [note(N1)] }, transitions: [{ resource: "photo", from: photo(B1).digest, to: null }],
    }, asAlice.sign);
    failedWith(await verify([genesis, withNote, stillGranted], [alice, bob]), 2, "STATE_EDITORS", "invalid-evidence");
    const narrowed = await updateOriginal(withNote, { versionTime: at(), remove: ["photo"], editors: [grant(bob.did, { name: true })], ...asAlice });
    expect((await verify([genesis, withNote, narrowed], [alice, bob])).history.status).toBe("valid");
  });
});

describe("C12-158: an added resource not in any grant", () => {
  test("no editor may change it until an author entry grants it (P5.15, P5.17)", async () => {
    const { alice, bob, at, genesis, asAlice, asBob } = await harbor((bob) => [grant(bob.did, { resources: ["photo"] })]);
    const withNote = await updateOriginal(genesis, { versionTime: at(), resources: [note(N1)], ...asAlice });
    // Bob's grant names photo only: the added note is not his to change.
    await expect(updateOriginal(withNote, { versionTime: at(), resources: [note(N2)], ...asBob })).rejects.toMatchObject({ category: "outside-grant", code: "EDITOR_OUTSIDE_GRANT" });
    const forged = await forge(withNote, {
      ...withNote.state, operation: "update", editor: bob.ref("edit"),
      asset: { ...assetOf(withNote), resources: [photo(B1), note(N2)] }, transitions: [{ resource: "note", from: note(N1).digest, to: note(N2).digest }],
    }, asBob.sign);
    failedWith(await verify([genesis, withNote, forged], [alice, bob]), 2, "EDITOR_OUTSIDE_GRANT", "outside-grant");
    // Once an author entry grants it, the next editor entry may change it.
    const granted = await updateOriginal(withNote, { versionTime: at(), editors: [grant(bob.did, { resources: ["photo", "note"] })], ...asAlice });
    const byBob = await updateOriginal(granted, { versionTime: at(), resources: [note(N2)], ...asBob });
    const r = await verify([genesis, withNote, granted, byBob], [alice, bob]);
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.resources.versions.filter((v) => v.resource === "note").map((v) => [v.version, v.versionId])).toEqual([[1, withNote.versionId], [2, byBob.versionId]]);
  });
});

describe("C12-158, C12-171: the author entry that adds a resource may grant it (PROVISIONAL reading of P5.15)", () => {
  test("the grant takes effect from the next entry, so only then may the editor change it (P5.17)", async () => {
    const { alice, bob, at, genesis, asAlice, asBob } = await harbor((bob) => [grant(bob.did, { resources: ["photo"] })]);
    const both = await updateOriginal(genesis, { versionTime: at(), resources: [note(N1)], editors: [grant(bob.did, { resources: ["photo", "note"] })], ...asAlice });
    const byBob = await updateOriginal(both, { versionTime: at(), resources: [note(N2)], ...asBob });
    const r = await verify([genesis, both, byBob], [alice, bob]);
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.resources.versions.filter((v) => v.resource === "note").map((v) => v.version)).toEqual([1, 2]);
  });
});

describe("C12-159: transitions for an added and a removed resource", () => {
  test("`from: null` for the added one and `to: null` for the removed one; resulting resources first, then removed ones in their previous order (P14.4)", async () => {
    const { alice, at, genesis, asAlice } = await harbor();
    const three = await updateOriginal(genesis, { versionTime: at(), resources: [note(N1), note(S1, "sketch")], ...asAlice });
    expect(three.state.transitions).toEqual([
      { resource: "note", from: null, to: note(N1).digest },
      { resource: "sketch", from: null, to: note(S1, "sketch").digest },
    ]);
    // Remove photo and sketch, change note and add caption in one entry.
    const mixed = await updateOriginal(three, { versionTime: at(), resources: [note(N2), note(B2, "caption")], remove: ["sketch", "photo"], ...asAlice });
    expect((mixed.state.asset as { resources: Array<{ id: string }> }).resources.map((r) => r.id)).toEqual(["note", "caption"]);
    expect(mixed.state.transitions).toEqual([
      { resource: "note", from: note(N1).digest, to: note(N2).digest },
      { resource: "caption", from: null, to: note(B2, "caption").digest },
      { resource: "photo", from: photo(B1).digest, to: null },
      { resource: "sketch", from: note(S1, "sketch").digest, to: null },
    ]);
    expect((await verify([genesis, three, mixed], [alice])).history.status).toBe("valid");
    // Any other order, or a missing or extra removal, is rejected.
    const t = mixed.state.transitions as JsonObject[];
    for (const transitions of [[t[0], t[1], t[3], t[2]], [t[2], t[3], t[0], t[1]], [t[0], t[1], t[2]], [t[0], t[1]]]) {
      const forged = await forge(three, { ...mixed.state, transitions }, asAlice.sign);
      failedWith(await verify([genesis, three, forged], [alice]), 2, "STATE_TRANSITIONS", "invalid-evidence");
    }
    // A removal's `to` is null, never a digest; an addition's `from` is null.
    const notNull = await forge(three, { ...mixed.state, transitions: [t[0], t[1], { ...t[2], to: photo(B1).digest }, t[3]] }, asAlice.sign);
    failedWith(await verify([genesis, three, notNull], [alice]), 2, "STATE_TRANSITIONS", "invalid-evidence");
  });
});

describe("C12-160: an Original with 256 resources / 257 resources (P14.13; originals-spec #50, merged, owner decision)", () => {
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => note(`r${from + i}`, `r${from + i}`));
  const manyBytes = (n: number, from = 0) => Object.fromEntries(many(n, from).map((d, i) => [d.digest, bytes(`r${from + i}`)]));

  test("256 resources at one time are accepted; a 257th is limit-exceeded, from the builder and in a forged entry", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KA }]);
    const at = clock();
    const author = { author: alice.ref("orig"), sign: alice.signer(KA, "orig") };
    const genesis = await createOriginal({ versionTime: at(), name: "Many", resources: many(256), ...author });
    const ok = await verifyOriginal({ log: [genesis], authors: [alice.evidence()], now: NOW, bytes: manyBytes(257) });
    expect(ok.history.status, JSON.stringify(ok.history.failure)).toBe("valid");
    expect(ok.state?.resources.length).toBe(256);
    await expect(createOriginal({ versionTime: at(), name: "Too many", resources: many(257), ...author })).rejects.toMatchObject({ category: "limit-exceeded", code: "STATE_TOO_MANY_RESOURCES" });
    await expect(updateOriginal(genesis, { versionTime: at(), resources: many(1, 256), ...author })).rejects.toMatchObject({ category: "limit-exceeded", code: "STATE_TOO_MANY_RESOURCES" });
    const forged = await forge(genesis, {
      ...genesis.state, operation: "update", asset: { ...assetOf(genesis), resources: many(257) },
      transitions: [{ resource: "r256", from: null, to: many(1, 256)[0].digest }],
    }, author.sign);
    const r = await verifyOriginal({ log: [genesis, forged], authors: [alice.evidence()], now: NOW, bytes: manyBytes(257) });
    expect(r.history.status).toBe("limit-exceeded");
    expect(r.history.failure).toMatchObject({ index: 1, code: "STATE_TOO_MANY_RESOURCES", category: "limit-exceeded" });
    // The limit is on resources at any one time: removing one makes room for another (P4.1).
    const swapped = await updateOriginal(genesis, { versionTime: at(), resources: many(1, 256), remove: ["r0"], ...author });
    const s = await verifyOriginal({ log: [genesis, swapped], authors: [alice.evidence()], now: NOW, bytes: manyBytes(257) });
    expect(s.history.status, JSON.stringify(s.history.failure)).toBe("valid");
    expect(s.state?.resources.length).toBe(256);
  });
});
