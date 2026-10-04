import { expect, test } from "bun:test";
import { OriginalsSDK } from "../../../src/index.js";
import {
  createLocalSigner,
  deriveAssetId,
  assetDigest,
  verifyScid,
  eventDigest,
} from "@originals/cel/v3";

test("new exports name the asset honestly and old signed v3 envelopes still recover", async () => {
  const sdk = OriginalsSDK.create({
    signer: createLocalSigner("Ed25519", new Uint8Array(32).fill(12)),
  });
  const asset = await sdk.lifecycle.createAsset([
    {
      id: "file",
      mediaType: "application/octet-stream",
      content: new Uint8Array([0, 255, 128]),
    },
  ]);
  const expected = deriveAssetId(asset.celLog.log[0].event);
  expect(asset.id).toBe(expected);
  expect(asset.id).toBe("did:cel:" + asset.celLog.log[0].event.previousEvent);
  const genesis = asset.celLog.log[0].event;
  expect(genesis.previousEvent).toBe(assetDigest(expected));
  expect(verifyScid(genesis, assetDigest(expected))).toBe(true);
  expect(eventDigest(genesis)).not.toBe(assetDigest(expected));
  expect(asset.serialize()).toMatchObject({ version: 4, assetId: expected });
  expect("assetDid" in asset.serialize()).toBe(false);
  expect("didCel" in asset.state).toBe(false);
  // The historical alias is reconstructible from the still-public digest helper,
  // without exposing a dedicated compatibility field on AssetState.
  const legacyAlias = "did:cel:" + assetDigest(asset.state.assetId);
  const old = {
    format: "originals/asset",
    version: 3,
    assetDid: legacyAlias,
    eventLog: asset.celLog,
    resources: asset.serialize().resources,
  };
  const before = JSON.stringify(old.eventLog);
  const restored = await OriginalsSDK.create().lifecycle.loadAsset(old);
  expect(restored.verification.verified).toBe(true);
  expect(restored.asset.id).toBe(expected);
  expect(JSON.stringify(restored.asset.celLog)).toBe(before);
  expect(restored.asset.resources[0].content).toEqual(
    new Uint8Array([0, 255, 128]),
  );
  const current = restored.asset.serialize();
  const tampered = { ...current, assetId: expected.slice(0, -2) + "AA" };
  await expect(
    OriginalsSDK.create().lifecycle.loadAsset(tampered, { allowPartial: true }),
  ).rejects.toThrow();
  const ni =
    "ni:///sha-256;" +
    Buffer.from(assetDigest(expected).slice(1), "base64url")
      .subarray(2)
      .toString("base64url");
  const retained = await OriginalsSDK.create().lifecycle.loadAsset({
    ...current,
    assetId: ni,
  });
  expect(retained.asset.id).toBe(expected);
  expect(retained.asset.serialize().assetId).toBe(expected);
  expect(JSON.stringify(retained.asset.celLog)).toBe(before);
  // Version 3 still has its original did-only contract; version 4 reads both spellings.
  await expect(
    OriginalsSDK.create().lifecycle.loadAsset({ ...old, assetDid: ni }),
  ).rejects.toThrow();
});
