import { expect, spyOn, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { normalizeAssetId } from "@originals/cel/v3";
import * as offline from "../../../src/asset-envelope.js";
import * as internal from "../../../src/v3/envelope.js";
import { OriginalsAsset } from "../../../src/v3/OriginalsAsset.js";
import { OriginalsSDK } from "../../../src/v3/OriginalsSDK.js";
import { OriginalsSDK as NetworkSDK } from "../../../src/index.js";
import bitcoinPrepared from "../../fixtures/identity/sdk3-bitcoin-publication.json";
import prepared from "../../fixtures/identity/sdk3-web-publication.json";

const expectedId = normalizeAssetId(prepared.asset.assetDid);
function signatures<T>(operation: () => T): { result: T; count: number } {
  const verify = spyOn(ed25519, "verify");
  try {
    const result = operation();
    return { result, count: verify.mock.calls.length };
  } finally {
    verify.mockRestore();
  }
}

test("offline inspection authenticates each proof once and returns detached bytes and immutable state", () => {
  const input = structuredClone(prepared.asset);
  const { result, count } = signatures(() => offline.inspectAssetEnvelope(input));
  expect(count).toBe(input.eventLog.log.length);
  expect(result.history).toMatchObject({ status: "authenticated", scope: "controller-history" });
  expect(result.history.state.assetId).toBe(expectedId);
  expect(result.history.state.alias).toBe(prepared.did);
  expect(Object.isFrozen(result.history)).toBe(true);
  expect(Object.isFrozen(result.history.state)).toBe(true);
  expect(Object.isFrozen(result.history.state.aliases)).toBe(true);
  expect(result.envelope.version).toBe(4);
  expect(Object.isFrozen(result.envelope)).toBe(false);
  result.envelope.assetId = "edited detached container";
  result.envelope.eventLog.log.pop();
  result.envelope.resources[0].content.data = "";
  expect(input).toEqual(prepared.asset);
  expect(result.history.state.assetId).toBe(expectedId);
  expect(result.history.state.entryCount).toBe(input.eventLog.log.length);
  const parsed = offline.parseAssetEnvelope(input);
  parsed.eventLog.log.pop();
  expect(input).toEqual(prepared.asset);
});

test("both public readers reject forged signatures and mismatched genesis identities", () => {
  const forged = structuredClone(prepared.asset);
  forged.eventLog.log[0].event.operation.data.name = "forged title";
  const mismatch = { ...offline.parseAssetEnvelope(prepared.asset), assetId: "ni:///sha-256;" + "A".repeat(43) };
  for (const read of [offline.parseAssetEnvelope, offline.inspectAssetEnvelope]) {
    expect(() => read(forged)).toThrow();
    expect(() => read(mismatch)).toThrow(expect.objectContaining({ code: "CEL_IDENTITY" }));
  }
});

test("internal decode retains strict container parsing without authenticating or becoming a public export", () => {
  const { result, count } = signatures(() => internal.decodeEnvelope(JSON.stringify(prepared.asset)));
  expect(count).toBe(0);
  expect(result.assetId).toBe(expectedId);
  expect("decodeEnvelope" in offline).toBe(false);
  expect(() => internal.decodeEnvelope({ ...prepared.asset, assetId: expectedId })).toThrow();
  expect(() => internal.decodeEnvelope({ ...result, assetId: prepared.asset.assetDid })).toThrow();
  expect(() => internal.decodeEnvelope(JSON.stringify(prepared.asset).replace('"version":3', '"version":3,"version":3'))).toThrow();
  expect(() => internal.decodeEnvelope({ ...result, resources: [{ ...result.resources[0], content: { encoding: "base64", data: "invalid!" } }] })).toThrow();
});

test("loading adds no signature pass before unconditional constructor and existing asset verification", async () => {
  const verify = spyOn(ed25519, "verify");
  try {
    const asset = new OriginalsAsset(prepared.asset.eventLog, prepared.asset.resources as never, {}, expectedId);
    await asset.verification();
    const existingVerificationCost = verify.mock.calls.length;
    verify.mockClear();
    const loaded = await OriginalsSDK.create().lifecycle.loadAsset(prepared.asset, { allowPartial: true });
    expect(verify.mock.calls.length).toBe(existingVerificationCost);
    expect(loaded.asset.id).toBe(expectedId);
    const forged = structuredClone(prepared.asset);
    forged.eventLog.log[0].event.operation.data.name = "forged title";
    await expect(OriginalsSDK.create().lifecycle.loadAsset(forged, { allowPartial: true })).rejects.toMatchObject({ code: "CEL_SIGNATURE" });
    const mismatch = { ...offline.parseAssetEnvelope(prepared.asset), assetId: "ni:///sha-256;" + "A".repeat(43) };
    await expect(OriginalsSDK.create().lifecycle.loadAsset(mismatch, { allowPartial: true })).rejects.toMatchObject({ code: "CEL_IDENTITY" });
  } finally {
    verify.mockRestore();
  }
});


test("Web publish and both Bitcoin ingestion paths reject forged decoded history before side effects", async () => {
  const forgedWeb = structuredClone(prepared);
  forgedWeb.asset.eventLog.log[0].event.operation.data.name = "forged title";
  const forgedBitcoin = structuredClone(bitcoinPrepared);
  forgedBitcoin.asset.eventLog.log[0].event.operation.data.name = "forged title";
  let effects = 0;
  const sdk = NetworkSDK.create({
    network: "regtest",
    storageAdapter: {
      async putObject() { effects++; throw new Error("Unexpected upload"); },
      async getObject() { effects++; throw new Error("Unexpected read"); },
      async exists() { effects++; throw new Error("Unexpected read"); },
    },
    ordinalsProvider: {
      async getFirstSatOfOutput() { effects++; throw new Error("Unexpected provider read"); },
      async broadcastTransaction() { effects++; throw new Error("Unexpected broadcast"); },
    } as never,
  });
  await expect(sdk.lifecycle.publishPreparedToWeb(forgedWeb)).rejects.toMatchObject({ code: "CEL_SIGNATURE" });
  await expect(sdk.lifecycle.prepareBitcoinPublication({ serialize: () => forgedWeb.asset } as never, {} as never)).rejects.toMatchObject({ code: "CEL_SIGNATURE" });
  await expect(sdk.lifecycle.publishPreparedToBitcoin(forgedBitcoin as never)).rejects.toMatchObject({ code: "CEL_SIGNATURE" });
  expect(effects).toBe(0);
});
