/**
 * Resource-set changes through the SDK (originals-spec #49; P4.1, P4.4,
 * P5.11, P5.15, P5.16, P8.3, P14.4). The author's `edit` adds a resource by
 * giving bytes for a new id, appended after the existing ones, and removes
 * resources with `remove`; an editor can do neither. Removed resources'
 * earlier versions stay in history, in packages and on hosts.
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { localSigner } from "@originals/vh/crypto";
import { createLog, serializeLog, signWith } from "@originals/vh/log";
import { resourceDigest, type AliasEvidence, type EditorGrant } from "@originals/vh/originals";
import { didWebvhFilesUrl } from "@originals/vh/webvh";
import { MemoryStore, OriginalsSDK, hostedFiles, type HostedFetch, type OriginalsSigner, type SigningRequest } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const B1 = bytes("harbor at dawn, first crop");
const B2 = bytes("harbor at dawn, tighter crop");
const N1 = bytes("a note about the harbor");
const N2 = bytes("a longer note about the harbor");
const KA = seed(21);
const KB = seed(31);

const grant = (did: string, g: Partial<Omit<EditorGrant, "did">> = {}): EditorGrant => ({ did, name: false, metadata: false, resources: [], ...g });

async function rejects(promise: Promise<unknown>, category: string, code?: string) {
  const caught = await promise.then(() => undefined, (e: unknown) => e);
  expect(caught, "expected a rejection").toBeInstanceOf(OriginalsError);
  expect((caught as OriginalsError).category).toBe(category as never);
  if (code) expect((caught as OriginalsError).code).toBe(code);
}

/** Alice's photo Original; Bob is granted the photo. */
async function harbor() {
  const alice = await Author.create([{ fragment: "orig", secret: KA }]);
  const bob = await Author.create([{ fragment: "edit", secret: KB }]);
  const dids = [alice, bob];
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: async (did) => dids.find((d) => d.did === did)?.evidence(), clock: clock() });
  const created = await sdk.create({
    name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }],
    author: alice.ref("orig"), signer: alice.signer("orig", KA), editors: [grant(bob.did, { resources: ["photo"] })],
  });
  if (created.kind !== "original") throw new Error("expected an Original");
  const asAlice = { author: alice.ref("orig"), signer: alice.signer("orig", KA) };
  const asBob = { editor: bob.ref("edit"), signer: bob.signer("edit", KB) };
  return { alice, bob, dids, store, sdk, did: created.original.did, v1: created.original.checkpoint, asAlice, asBob };
}

async function aliasFor(target: string): Promise<AliasEvidence> {
  const key = localSigner("Ed25519", seed(61));
  const k = key.publicKeyMultibase;
  const genesis = await createLog({
    versionTime: "2026-10-18T10:00:00Z",
    parameters: { method: "did:webvh:1.0", scid: "{SCID}", updateKeys: [k], portable: true },
    state: { id: "did:webvh:{SCID}:example.com:photos", alsoKnownAs: [target] },
    sign: signWith(key, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` }),
  });
  return { did: genesis.state.id as string, log: serializeLog([genesis]) };
}

describe("C12-16 through the API: the author adds and removes resources (P4.1, P4.4)", () => {
  test("an added resource is at version 1; a removed one stays verifiable in history and in a package", async () => {
    const { alice, sdk, did, v1, asAlice } = await harbor();
    const added = await sdk.edit(did, { parent: v1, resources: [{ id: "note", mediaType: "text/plain", bytes: N1 }], ...asAlice });
    expect(added.original.state.resources.map((r) => r.id)).toEqual(["photo", "note"]);
    const edited = await sdk.edit(did, { parent: added.original.checkpoint, resources: [{ id: "photo", bytes: B2 }, { id: "note", bytes: N2 }], ...asAlice });
    const removed = await sdk.edit(did, {
      parent: edited.original.checkpoint, remove: ["photo"], editors: null, ...asAlice,
    });
    expect(removed.status).toBe("committed");
    expect(removed.original.state.resources.map((r) => r.id)).toEqual(["note"]);
    expect(removed.original.resources.map((v) => [v.resource, v.version, v.bytes])).toEqual([
      ["photo", 1, "verified"], ["note", 1, "verified"], ["photo", 2, "verified"], ["note", 2, "verified"],
    ]);
    // A package carries the removed photo's earlier bytes and verifies in a fresh reader (P7.1, P8.3).
    const pkg = await sdk.package(did);
    expect(pkg.manifest.completeness).toBe("complete");
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const loaded = await reader.load(pkg.bytes);
    expect(loaded.report.history.status).toBe("valid");
    expect(loaded.report.resources.status).toBe("available");
    expect(loaded.report.resources.versions.filter((v) => v.resource === "photo").map((v) => [v.version, v.digest, v.bytes])).toEqual([
      [1, resourceDigest(B1), "verified"], [2, resourceDigest(B2), "verified"],
    ]);
    // The checkpoint before the removal still shows the photo.
    expect((await sdk.get(did, { checkpoint: edited.original.checkpoint })).state.resources.map((r) => r.id)).toEqual(["photo", "note"]);
  });

  test("a hosted snapshot serves a removed resource's earlier bytes, and a stranger verifies them (P8.3, P9.1)", async () => {
    const { sdk, did, v1, asAlice } = await harbor();
    const alias = await aliasFor(did);
    const p = await sdk.publish(did, { parent: v1, author: asAlice.author, signer: asAlice.signer, alias });
    const added = await sdk.edit(did, { parent: p.original.checkpoint, resources: [{ id: "note", mediaType: "text/plain", bytes: N1 }], ...asAlice });
    await sdk.edit(did, { parent: added.original.checkpoint, remove: ["photo"], editors: null, ...asAlice });
    const files = await hostedFiles(sdk, did, alias);
    expect([...files.keys()].some((path) => path.endsWith(`resources/${resourceDigest(B1)}`))).toBe(true);
    const base = didWebvhFilesUrl(alias.did);
    const fetch: HostedFetch = (url) => {
      const data = url.startsWith(base) ? files.get(url.slice(base.length)) : undefined;
      return data ? Promise.resolve(data.slice()) : Promise.reject(new OriginalsError("unavailable-bytes", "FETCH_STATUS", `${url} answered 404`));
    };
    const stranger = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const r = await stranger.loadPublished(alias.did, fetch);
    expect(r.report.history.status).toBe("valid");
    expect(r.report.state?.resources.map((d) => d.id)).toEqual(["note"]);
    expect(r.report.resources.versions.map((v) => [v.resource, v.version, v.bytes])).toEqual([["photo", 1, "verified"], ["note", 1, "verified"]]);
  });

  test("the signer is shown each addition and removal (P5.11)", async () => {
    const { sdk, did, v1, asAlice } = await harbor();
    const seen: SigningRequest[] = [];
    const watching: OriginalsSigner = { ...asAlice.signer, sign: (r) => (seen.push(r), asAlice.signer.sign(r)) };
    const added = await sdk.edit(did, { parent: v1, resources: [{ id: "note", mediaType: "text/plain", bytes: N1 }], author: asAlice.author, signer: watching });
    await sdk.edit(did, { parent: added.original.checkpoint, remove: ["photo"], editors: null, author: asAlice.author, signer: watching });
    expect(seen[0].display).toContain(`Resource note: added ${resourceDigest(N1)}`);
    expect(seen[1].display).toContain(`Resource photo: removed (was ${resourceDigest(B1)}`);
    expect(seen[1].summary.changes).toEqual([{ resource: "photo", from: resourceDigest(B1), to: null }]);
    expect(seen[1].display).toContain("Editor grants: changed (none remain)");
  });

  test("an added resource needs its media type, and remove takes resourceIDs (input errors)", async () => {
    const { sdk, store, did, v1, asAlice } = await harbor();
    await rejects(sdk.edit(did, { parent: v1, resources: [{ id: "note", bytes: N1 }], ...asAlice }), "invalid-evidence", "INPUT_INVALID");
    await rejects(sdk.edit(did, { parent: v1, remove: "photo" as never, ...asAlice }), "invalid-evidence", "INPUT_INVALID");
    await rejects(sdk.edit(did, { parent: v1, remove: ["note"], ...asAlice }), "invalid-evidence", "STATE_RESOURCE_SET");
    expect((await store.get(did))?.log.trimEnd().split("\n").length).toBe(1);
  });
});

describe("C12-154 through the API: an editor cannot add or remove a resource (P5.16)", () => {
  test("nothing is signed and nothing is stored", async () => {
    const { sdk, store, did, v1, asBob, asAlice, bob } = await harbor();
    let asked = 0;
    const counting: OriginalsSigner = { ...asBob.signer, sign: (r) => (asked++, asBob.signer.sign(r)) };
    await rejects(sdk.edit(did, { parent: v1, resources: [{ id: "note", mediaType: "text/plain", bytes: N1 }], editor: asBob.editor, signer: counting }), "outside-grant", "EDITOR_AUTHOR_ONLY");
    const withNote = await sdk.edit(did, { parent: v1, resources: [{ id: "note", mediaType: "text/plain", bytes: N1 }], editors: [grant(bob.did, { resources: ["photo", "note"] })], ...asAlice });
    await rejects(sdk.edit(did, { parent: withNote.original.checkpoint, remove: ["note"], editor: asBob.editor, signer: counting }), "outside-grant", "EDITOR_AUTHOR_ONLY");
    expect(asked).toBe(0);
    expect((await store.get(did))?.log.trimEnd().split("\n").length).toBe(2);
  });
});

describe("C12-155 through the API: a resourceID is never used again (P4.1)", () => {
  test("re-adding a removed resource's id is refused before signing", async () => {
    const { sdk, did, v1, asAlice } = await harbor();
    const added = await sdk.edit(did, { parent: v1, resources: [{ id: "note", mediaType: "text/plain", bytes: N1 }], ...asAlice });
    const removed = await sdk.edit(did, { parent: added.original.checkpoint, remove: ["note"], ...asAlice });
    await rejects(sdk.edit(did, { parent: removed.original.checkpoint, resources: [{ id: "note", mediaType: "text/plain", bytes: N2 }], ...asAlice }), "invalid-evidence", "STATE_RESOURCE_REUSED");
    // A fresh id is fine.
    const fresh = await sdk.edit(did, { parent: removed.original.checkpoint, resources: [{ id: "note-2", mediaType: "text/plain", bytes: N2 }], ...asAlice });
    expect(fresh.original.state.resources.map((r) => r.id)).toEqual(["photo", "note-2"]);
    expect(fresh.original.resources.filter((v) => v.resource === "note-2").map((v) => v.version)).toEqual([1]);
  });
});

describe("C12-156 through the API: the last resource cannot be removed (P4.1)", () => {
  test("is refused", async () => {
    const { sdk, did, v1, asAlice } = await harbor();
    await rejects(sdk.edit(did, { parent: v1, remove: ["photo"], editors: null, ...asAlice }), "invalid-evidence", "STATE_RESOURCE_SET");
  });
});

describe("C12-157 through the API: removing a resource a grant still names (P5.15)", () => {
  test("is refused until the grants are narrowed in the same entry", async () => {
    const { sdk, did, v1, asAlice, bob } = await harbor();
    const added = await sdk.edit(did, { parent: v1, resources: [{ id: "note", mediaType: "text/plain", bytes: N1 }], ...asAlice });
    await rejects(sdk.edit(did, { parent: added.original.checkpoint, remove: ["photo"], ...asAlice }), "invalid-evidence", "STATE_EDITORS");
    const narrowed = await sdk.edit(did, { parent: added.original.checkpoint, remove: ["photo"], editors: [grant(bob.did, { name: true })], ...asAlice });
    expect(narrowed.original.state.editors).toEqual([grant(bob.did, { name: true })]);
  });
});

describe("C12-158 through the API: an added resource is in no grant until the author grants it (P5.15)", () => {
  test("Bob may not change the note until Alice grants it, then may", async () => {
    const { sdk, did, v1, asAlice, asBob, bob } = await harbor();
    const added = await sdk.edit(did, { parent: v1, resources: [{ id: "note", mediaType: "text/plain", bytes: N1 }], ...asAlice });
    await rejects(sdk.edit(did, { parent: added.original.checkpoint, resources: [{ id: "note", bytes: N2 }], ...asBob }), "outside-grant", "EDITOR_OUTSIDE_GRANT");
    const granted = await sdk.edit(did, { parent: added.original.checkpoint, editors: [grant(bob.did, { resources: ["photo", "note"] })], ...asAlice });
    const byBob = await sdk.edit(did, { parent: granted.original.checkpoint, resources: [{ id: "note", bytes: N2 }], ...asBob });
    expect(byBob.original.resources.filter((v) => v.resource === "note").map((v) => v.version)).toEqual([1, 2]);
  });
});

describe("C12-159 through the API: transitions for an added and a removed resource (P14.4)", () => {
  test("the resulting resources in order, then the removed ones", async () => {
    const { sdk, did, v1, asAlice } = await harbor();
    const added = await sdk.edit(did, { parent: v1, resources: [{ id: "note", mediaType: "text/plain", bytes: N1 }], ...asAlice });
    const draft = await sdk.prepareEdit(did, {
      parent: added.original.checkpoint, resources: [{ id: "note", bytes: N2 }, { id: "sketch", mediaType: "image/png", bytes: B2 }], remove: ["photo"], editors: null, author: asAlice.author,
    });
    expect(draft.summary.changes).toEqual([
      { resource: "note", from: resourceDigest(N1), to: resourceDigest(N2) },
      { resource: "sketch", from: null, to: resourceDigest(B2) },
      { resource: "photo", from: resourceDigest(B1), to: null },
    ]);
    const committed = await sdk.commit(draft, asAlice.signer);
    expect(committed.original.state.resources.map((r) => r.id)).toEqual(["note", "sketch"]);
  });
});
