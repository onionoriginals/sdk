import { expect, test } from "bun:test";
import { OriginalsSDK } from "../../../src/index.js";
import {
  createLocalSigner,
  signEvent,
  encodeDocument,
  type SatSnapshot,
  eventDigest,
} from "@originals/cel/v3";

const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(7));
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
const txid = "a".repeat(64),
  blockHash = "b".repeat(64);
async function boundary() {
  const asset = await OriginalsSDK.create({ signer }).lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: png },
  ]);
  const web =
    "did:webvh:QmWmyoCVmCuFjPT9fAtP8jCFXbT8Zzq5TGfxEbGoZFbBfo:example.com:art";
  const hosted = await signEvent(
    {
      previousEvent: asset.state.head,
      operation: {
        type: "migrate",
        data: {
          profile: "originals/cel/3",
          from: asset.id,
          to: web,
          layer: "webvh",
          migratedAt: "2026-09-06T00:00:00Z",
        },
      },
    },
    signer,
  );
  const migration = await signEvent(
    {
      previousEvent: eventDigest(hosted.event),
      operation: {
        type: "migrate",
        data: {
          profile: "originals/cel/3",
          from: web,
          to: "did:btco:reg:123",
          layer: "btco",
          migratedAt: "2026-09-06T00:00:00Z",
        },
      },
    },
    signer,
  );
  const log = { log: [...asset.celLog.log, hosted, migration] };
  const snapshot: SatSnapshot = {
    network: "regtest",
    sat: "123",
    tipBefore: { height: 100, hash: blockHash },
    tipAfter: { height: 100, hash: blockHash },
    indexTip: { height: 100, hash: blockHash },
    indexHealthy: true,
    enumerationComplete: true,
    blocks: [{ height: 100, hash: blockHash, txids: [txid] }],
    ownership: { owner: "holder", satpoint: txid + ":0:0" },
    publications: [
      {
        id: txid + "i0",
        revealTxid: txid,
        network: "regtest",
        sat: "123",
        confirmed: true,
        creation: {
          height: 100,
          blockHash,
          transactionIndex: 0,
          inscriptionIndex: 0,
        },
        body: {
          status: "complete",
          mediaType: "image/png",
          bytes: png,
          metadata: encodeDocument(log, "cbor"),
        },
      },
    ],
  };
  return { snapshot, asset, log };
}

test("a fresh consumer resolves binary bytes and DID authority from the same accepted sat history", async () => {
  const { snapshot, asset } = await boundary();
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.asset.id).toBe(asset.id);
  expect(result.asset.resources[0].content).toEqual(png);
  expect(result.resolution.state.controller).toBe(signer.controller);
  expect(result.verification.resources).toBe("verified");
  const did = await sdk.did.resolveDID("did:btco:reg:123");
  expect(did?.id).toBe("did:btco:reg:123");
  expect(did?.controller).toEqual([signer.controller]);
  expect(did?.alsoKnownAs).toContain(asset.id);
  const metadata = await sdk.did.resolveDIDWithMetadata("did:btco:reg:123");
  expect(metadata.didDocumentMetadata.ownership).toEqual(snapshot.ownership);
  expect(metadata.didDocumentMetadata.head).toBe(result.asset.state.head);
});

test("network recovery and verify re-read the accepted head instead of trusting serialized Bitcoin claims", async () => {
  const { snapshot } = await boundary();
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  const loaded = await sdk.lifecycle.loadAsset(
    JSON.stringify(result.asset.serialize()),
  );
  expect(loaded.verification.verified).toBe(true);
  expect(await loaded.asset.verify()).toBe(true);
  snapshot.indexHealthy = false;
  expect(await loaded.asset.verify()).toBe(false);
  await expect(
    sdk.lifecycle.loadAsset(result.asset.serialize()),
  ).rejects.toThrow("not fully verified");
  await expect(sdk.did.resolveDID("did:btco:reg:123")).rejects.toThrow();
});

test("log-only publication keeps missing bytes explicit and unrelated raw DID content cannot replace authority", async () => {
  const { snapshot, log } = await boundary();
  snapshot.publications[0].body = {
    status: "complete",
    mediaType: "application/cel",
    bytes: encodeDocument(log, "json"),
    metadata: null,
  };
  const rawTx = "c".repeat(64);
  snapshot.blocks[0].txids.push(rawTx);
  snapshot.publications.push({
    ...snapshot.publications[0],
    id: rawTx + "i0",
    revealTxid: rawTx,
    creation: { ...snapshot.publications[0].creation!, transactionIndex: 1 },
    body: {
      status: "complete",
      mediaType: "application/json",
      metadata: null,
      bytes: new TextEncoder().encode(
        JSON.stringify({ id: "did:btco:reg:123", controller: ["attacker"] }),
      ),
    },
  });
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.verification.verified).toBe(false);
  expect(result.verification.missingResources).toEqual([
    { id: "art", version: 1 },
  ]);
  expect(result.asset.resources[0].content).toBeUndefined();
  expect((await sdk.did.resolveDID("did:btco:reg:123"))?.controller).toEqual([
    signer.controller,
  ]);
});

test("rotation and updates in one later publication retire the prior key independently of sale and reacquisition", async () => {
  const { snapshot, log } = await boundary();
  const nextSigner = createLocalSigner("Ed25519", new Uint8Array(32).fill(8));
  const rotation = await signEvent(
    {
      previousEvent: eventDigest(log.log.at(-1)!.event),
      operation: {
        type: "rotateKey",
        data: {
          profile: "originals/cel/3",
          newController: nextSigner.controller,
          rotatedAt: "2026-09-06T00:00:01Z",
        },
      },
    },
    signer,
  );
  const update = await signEvent(
    {
      previousEvent: eventDigest(rotation.event),
      operation: {
        type: "update",
        data: { profile: "originals/cel/3", name: "By the current controller" },
      },
    },
    nextSigner,
  );
  const nextTx = "c".repeat(64),
    nextHash = "d".repeat(64);
  snapshot.tipBefore =
    snapshot.tipAfter =
    snapshot.indexTip =
      { height: 101, hash: nextHash };
  snapshot.blocks.push({ height: 101, hash: nextHash, txids: [nextTx] });
  snapshot.publications.unshift({
    id: nextTx + "i0",
    revealTxid: nextTx,
    network: "regtest",
    sat: "123",
    confirmed: true,
    creation: {
      height: 101,
      blockHash: nextHash,
      transactionIndex: 0,
      inscriptionIndex: 0,
    },
    body: {
      status: "complete",
      mediaType: "application/cel",
      bytes: encodeDocument({ log: [rotation, update] }, "json"),
      metadata: null,
    },
  });
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  for (const owner of ["buyer", "original holder"]) {
    snapshot.ownership.owner = owner;
    const result = await sdk.lifecycle.resolveAssetFromSat("123");
    if (result.status !== "accepted") throw new Error(result.status);
    expect(result.asset.state.name).toBe("By the current controller");
    expect(result.asset.state.controller).toBe(nextSigner.controller);
    expect(result.asset.resources[0].content).toEqual(png);
    expect((await sdk.did.resolveDID("did:btco:reg:123"))?.controller).toEqual([
      nextSigner.controller,
    ]);
    await expect(
      result.asset.update({ name: "Retired key" }, { signer }),
    ).rejects.toThrow("current controller");
  }
});

test('resolution retries a changing snapshot and bounds failures if the chain cannot stabilize', async () => {
  const { snapshot } = await boundary(); let calls = 0;
  const changing = structuredClone(snapshot); changing.tipAfter.hash = 'e'.repeat(64);
  const sdk = OriginalsSDK.create({ network: 'regtest', satProvider: { getSatSnapshot: async () => ++calls === 1 ? changing : snapshot } });
  expect((await sdk.lifecycle.resolveAssetFromSat('123')).status).toBe('accepted');
  expect(calls).toBe(2);
  calls = 0;
  const unstable = OriginalsSDK.create({ network: 'regtest', satProvider: { getSatSnapshot: async () => { calls++; return changing; } } });
  expect((await unstable.lifecycle.resolveAssetFromSat('123')).status).toBe('chain-changed');
  expect(calls).toBe(3);
});


test("resolution retries provider-detected chain movement without accepting partial evidence", async () => {
  const { snapshot } = await boundary();
  let reads = 0;
  const sdk = OriginalsSDK.create({ network: "regtest", satProvider: { async getSatSnapshot() {
    if (++reads === 1) throw Object.assign(new Error("index moved"), { code: "SAT_SNAPSHOT_CHAIN_CHANGED" });
    return snapshot;
  } } });
  expect((await sdk.lifecycle.resolveAssetFromSat("123")).status).toBe("accepted");
  expect(reads).toBe(2);
});
