/**
 * The Original's one resource through the SDK (originals-spec #53, owner
 * decision of 1 November 2026; P4.1, P4.4, P4.5, P5.11, P5.16, P8.3, P14.4).
 * An Original is exactly one resource, which can have many versions: `create`
 * gives its first version, and `edit` with new bytes gives its next one.
 * Earlier versions stay in history, in packages and on hosts.
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { localSigner } from "@originals/vh/crypto";
import { createLog, prepareGenesis, serializeLog, signEntry, signWith } from "@originals/vh/log";
import { resourceDigest, type AliasEvidence, type EditorGrant } from "@originals/vh/originals";
import { didWebvhFilesUrl } from "@originals/vh/webvh";
import { MemoryStore, OriginalsSDK, hostedFiles, readZip, writeZip, type HostedFetch, type OriginalsSigner, type SigningRequest } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const B1 = bytes("harbor at dawn, first crop");
const B2 = bytes("harbor at dawn, tighter crop");
const B3 = bytes("harbor at dawn, final crop");
const KA = seed(21);
const KB = seed(31);

const grant = (did: string, g: Partial<Omit<EditorGrant, "did">> = {}): EditorGrant => ({ did, name: false, metadata: false, resource: false, ...g });

async function rejects(promise: Promise<unknown>, category: string, code?: string) {
  const caught = await promise.then(() => undefined, (e: unknown) => e);
  expect(caught, "expected a rejection").toBeInstanceOf(OriginalsError);
  expect((caught as OriginalsError).category).toBe(category as never);
  if (code) expect((caught as OriginalsError).code).toBe(code);
}

/** Alice's photo Original; Bob may make new versions of the photo. */
async function harbor() {
  const alice = await Author.create([{ fragment: "orig", secret: KA }]);
  const bob = await Author.create([{ fragment: "edit", secret: KB }]);
  const dids = [alice, bob];
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: async (did) => dids.find((d) => d.did === did)?.evidence(), clock: clock() });
  const created = await sdk.create({
    name: "Harbor at dawn", resource: { mediaType: "image/jpeg", bytes: B1 },
    author: alice.ref("orig"), signer: alice.signer("orig", KA), editors: [grant(bob.did, { resource: true })],
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

const headState = async (sdk: OriginalsSDK, did: string) =>
  (JSON.parse((await sdk.committedLog(did)).trimEnd().split("\n").at(-1)!) as { state: { transitions: unknown[] } }).state;

describe("one resource, many versions (P4.1, P4.4, P8.3)", () => {
  test("new bytes are the next version; earlier versions stay verifiable in history and in a package", async () => {
    const { alice, sdk, did, v1, asAlice } = await harbor();
    const second = await sdk.edit(did, { parent: v1, resource: { bytes: B2 }, ...asAlice });
    const third = await sdk.edit(did, { parent: second.original.checkpoint, resource: { bytes: B3, mediaType: "image/png" }, ...asAlice });
    expect(third.original.state.resource).toEqual({ mediaType: "image/png", size: B3.length, digest: resourceDigest(B3) });
    expect(third.original.resources.map((v) => [v.version, v.digest, v.bytes])).toEqual([
      [1, resourceDigest(B1), "verified"], [2, resourceDigest(B2), "verified"], [3, resourceDigest(B3), "verified"],
    ]);
    // A package carries every version and verifies in a fresh reader (P7.1, P8.3).
    const pkg = await sdk.package(did);
    expect(pkg.manifest.completeness).toBe("complete");
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const loaded = await reader.load(pkg.bytes);
    expect(loaded.report.history.status).toBe("valid");
    expect(loaded.report.resources.status).toBe("available");
    expect(loaded.report.resources.versions.map((v) => [v.version, v.bytes])).toEqual([[1, "verified"], [2, "verified"], [3, "verified"]]);
    // An earlier checkpoint still shows the earlier version.
    expect((await sdk.get(did, { checkpoint: v1 })).state.resource.digest).toBe(resourceDigest(B1));
  });

  test("a hosted snapshot serves earlier versions, and a stranger verifies them (P8.3, P9.1)", async () => {
    const { sdk, did, v1, asAlice } = await harbor();
    const alias = await aliasFor(did);
    const p = await sdk.publish(did, { parent: v1, author: asAlice.author, signer: asAlice.signer, alias });
    await sdk.edit(did, { parent: p.original.checkpoint, resource: { bytes: B2 }, ...asAlice });
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
    expect(r.report.state?.resource.digest).toBe(resourceDigest(B2));
    expect(r.report.resources.versions.map((v) => [v.version, v.bytes])).toEqual([[1, "verified"], [2, "verified"]]);
  });

  test("the signer is shown the first version and each new one (P5.11)", async () => {
    const { alice, sdk, did, v1, asAlice } = await harbor();
    const seen: SigningRequest[] = [];
    const watching: OriginalsSigner = { ...asAlice.signer, sign: (r) => (seen.push(r), asAlice.signer.sign(r)) };
    await sdk.edit(did, { parent: v1, resource: { bytes: B2 }, author: asAlice.author, signer: watching });
    expect(seen[0].summary.changes).toEqual([{ from: resourceDigest(B1), to: resourceDigest(B2) }]);
    expect(seen[0].display).toContain(`Resource: new version ${resourceDigest(B1)} -> ${resourceDigest(B2)}`);
    const fresh = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock() });
    await fresh.create({ name: "Other", resource: { mediaType: "image/jpeg", bytes: B3 }, author: asAlice.author, signer: watching });
    expect(seen[1].display).toContain(`Resource: first version ${resourceDigest(B3)}`);
  });
});

describe("C12-19 through the API: the same bytes leave the version unchanged (P4.4, P14.4)", () => {
  test("no new version, and the entry's transitions are empty", async () => {
    const { sdk, did, v1, asAlice } = await harbor();
    const same = await sdk.edit(did, { parent: v1, resource: { bytes: B1 }, name: "Harbor", ...asAlice });
    expect(same.original.resources.map((v) => v.version)).toEqual([1]);
    expect((await headState(sdk, did)).transitions).toEqual([]);
  });
});

describe("C12-159 through the API: transitions in the genesis entry / a changing entry / any other (P14.4)", () => {
  test("[{from: null, to}] / [{from, to}] / []", async () => {
    const { sdk, did, v1, asAlice } = await harbor();
    expect((await headState(sdk, did)).transitions).toEqual([{ from: null, to: resourceDigest(B1) }]);
    const changed = await sdk.edit(did, { parent: v1, resource: { bytes: B2 }, ...asAlice });
    expect((await headState(sdk, did)).transitions).toEqual([{ from: resourceDigest(B1), to: resourceDigest(B2) }]);
    const renamed = await sdk.edit(did, { parent: changed.original.checkpoint, metadata: { caption: "x" }, ...asAlice });
    expect((await headState(sdk, did)).transitions).toEqual([]);
    await sdk.deactivate(did, { parent: renamed.original.checkpoint, ...asAlice });
    expect((await headState(sdk, did)).transitions).toEqual([]);
  });
});

describe("conflicts and input errors (P4.1, P4.5)", () => {
  test("an edit made from other bytes than the current version's is STALE_DIGEST, never a rebase (P4.5)", async () => {
    const { store, sdk, did, v1, asAlice } = await harbor();
    const second = await sdk.edit(did, { parent: v1, resource: { bytes: B2, expectedDigest: resourceDigest(B1) }, ...asAlice });
    await rejects(sdk.edit(did, { parent: second.original.checkpoint, resource: { bytes: B3, expectedDigest: resourceDigest(B1) }, ...asAlice }), "stale-parent", "STALE_DIGEST");
    expect((await store.get(did))?.log.trimEnd().split("\n").length).toBe(2);
  });

  test("a resource set, an id or a removal is refused: an Original has exactly one resource (P4.1)", async () => {
    const { store, sdk, alice, did, v1, asAlice } = await harbor();
    await rejects(sdk.edit(did, { parent: v1, resources: [{ id: "note", bytes: B2 }], ...asAlice } as never), "invalid-evidence", "INPUT_INVALID");
    await rejects(sdk.edit(did, { parent: v1, remove: ["photo"], ...asAlice } as never), "invalid-evidence", "INPUT_INVALID");
    await rejects(sdk.edit(did, { parent: v1, resource: { id: "photo", bytes: B2 }, ...asAlice } as never), "invalid-evidence", "INPUT_INVALID");
    await rejects(sdk.edit(did, { parent: v1, resource: [{ bytes: B2 }], ...asAlice } as never), "invalid-evidence", "INPUT_INVALID");
    expect((await store.get(did))?.log.trimEnd().split("\n").length).toBe(1);
    const fresh = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock() });
    await rejects(fresh.create({ name: "Two", resources: [{ id: "a", mediaType: "image/jpeg", bytes: B1 }], ...asAlice } as never), "invalid-evidence", "INPUT_INVALID");
    await rejects(fresh.create({ name: "None", ...asAlice } as never), "invalid-evidence", "INPUT_INVALID");
  });

  test("an editor granted the resource makes its next version; one without the grant is refused (P5.16)", async () => {
    const { alice, sdk, did, v1, asBob } = await harbor();
    const byBob = await sdk.edit(did, { parent: v1, resource: { bytes: B2 }, ...asBob });
    expect(byBob.original.resources.map((v) => v.version)).toEqual([1, 2]);
    const carol = await Author.create([{ fragment: "edit", secret: seed(41) }]);
    const other = OriginalsSDK.create({ store: new MemoryStore(), authors: async (d) => [alice, carol].find((x) => x.did === d)?.evidence(), clock: clock() });
    const c = await other.create({ name: "Harbor", resource: { mediaType: "image/jpeg", bytes: B1 }, author: alice.ref("orig"), signer: alice.signer("orig", KA), editors: [grant(carol.did, { metadata: true })] });
    if (c.kind !== "original") throw new Error("expected an Original");
    await rejects(other.edit(c.original.did, { parent: c.original.checkpoint, resource: { bytes: B2 }, editor: carol.ref("edit"), signer: carol.signer("edit", seed(41)) }), "outside-grant", "EDITOR_OUTSIDE_GRANT");
  });
});

describe("C12-16 through the API: a state with no resource, or more than one, is rejected (P4.1, P14.5)", () => {
  test("a package whose signed genesis lists the resource as an array, or omits it, does not verify", async () => {
    const { alice, sdk, did } = await harbor();
    const pkg = readZip((await sdk.package(did)).bytes);
    const descriptor = { mediaType: "image/jpeg", size: B1.length, digest: resourceDigest(B1) };
    const sign = signWith(localSigner("Ed25519", KA), { cryptosuite: "eddsa-jcs-2022", verificationMethod: alice.ref("orig").verificationMethod });
    for (const asset of [
      { name: "Harbor", status: "active", resource: [descriptor], aliases: [] },
      { name: "Harbor", status: "active", resource: [descriptor, descriptor], aliases: [] },
      { name: "Harbor", status: "active", resources: [descriptor], aliases: [] },
      { name: "Harbor", status: "active", aliases: [] },
    ]) {
      const forged = await signEntry(prepareGenesis({
        versionTime: "2026-10-18T12:00:00.000Z",
        parameters: { method: "originals:1.0", scid: "{SCID}" },
        state: { id: "did:vh:{SCID}", operation: "create", author: alice.ref("orig"), asset, transitions: [{ from: null, to: descriptor.digest }] } as never,
      }), sign);
      const files = new Map(pkg);
      files.set("asset/did.jsonl", bytes(serializeLog([forged])));
      const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
      const loaded = await reader.load(writeZip(files));
      expect(loaded.report.history.status, JSON.stringify(asset)).toBe("invalid");
      expect(["STATE_RESOURCE", "STATE_MEMBERS"]).toContain(loaded.report.history.failure?.code ?? "");
      expect(loaded.report.history.failure?.message).toContain("resource");
    }
  });
});
