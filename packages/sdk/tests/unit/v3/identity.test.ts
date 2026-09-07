import { expect, test } from "bun:test";
import { OriginalsSDK } from "../../../src/index.js";
import { createLocalSigner, deriveAssetId } from "@originals/cel/v3";

test("new exports name the asset honestly and old signed v3 envelopes still recover", async () => {
  const sdk = OriginalsSDK.create({ signer: createLocalSigner("Ed25519", new Uint8Array(32).fill(12)) });
  const asset = await sdk.lifecycle.createAsset([{ id: "file", mediaType: "application/octet-stream", content: new Uint8Array([0, 255, 128]) }]);
  const expected = deriveAssetId(asset.celLog.log[0].event);
  expect(asset.id).toBe(expected);
  expect(asset.serialize()).toMatchObject({ version: 4, assetId: expected });
  expect("assetDid" in asset.serialize()).toBe(false);
  const old = { format: "originals/asset", version: 3, assetDid: asset.state.didCel,
    eventLog: asset.celLog, resources: asset.serialize().resources };
  const before = JSON.stringify(old.eventLog);
  const restored = await OriginalsSDK.create().lifecycle.loadAsset(old);
  expect(restored.verification.verified).toBe(true);
  expect(restored.asset.id).toBe(expected);
  expect(JSON.stringify(restored.asset.celLog)).toBe(before);
  expect(restored.asset.resources[0].content).toEqual(new Uint8Array([0, 255, 128]));
  const current = restored.asset.serialize();
  const tampered = { ...current, assetId: expected.slice(0, -2) + "AA" };
  await expect(OriginalsSDK.create().lifecycle.loadAsset(tampered, { allowPartial: true })).rejects.toThrow();
  await expect(OriginalsSDK.create().lifecycle.loadAsset({ ...old, assetDid: expected })).rejects.toThrow();
  await expect(OriginalsSDK.create().lifecycle.loadAsset({ ...current, assetId: old.assetDid })).rejects.toThrow();
});
