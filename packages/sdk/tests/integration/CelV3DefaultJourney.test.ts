import { expect, test } from "bun:test";
import DefaultSDK, { OriginalsSDK, OriginalsAsset } from "../../src/index.js";
import { createLocalSigner } from "@originals/cel/v3";

// Package-root creation, mutation and fresh recovery are the public cutover seam.
test("the default SDK preserves concurrent CEL 3 edits and exact bytes through fresh recovery", async () => {
  const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(31));
  const sdk = OriginalsSDK.create({ signer });
  const original = new Uint8Array([0, 255, 128, 10]);
  const revised = new Uint8Array([255, 0, 127, 13]);
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: original },
  ]);
  expect(asset).toBeInstanceOf(OriginalsAsset);
  expect(asset.celLog.log[0].event.operation.data.profile).toBe(
    "originals/cel/3",
  );
  await Promise.all([
    asset.update({ name: "A revised Original" }),
    asset.addResourceVersion("art", revised, "image/png"),
  ]);
  const restored = await DefaultSDK.create().lifecycle.loadAsset(
    JSON.stringify(asset.serialize()),
  );
  expect(restored.verification.verified).toBe(true);
  expect(await asset.verify()).toBe(true);
  expect(restored.asset.state).toEqual(asset.state);
  expect(restored.asset.state.entryCount).toBe(3);
  expect(restored.asset.resources[0].content).toEqual(original);
  expect(restored.asset.resources[1].content).toEqual(revised);
});

test("default loading refuses a valid previous-format asset, including partial mode", async () => {
  const { OriginalsSDK: PreviousSDK } = await import("../previous-sdk.js");
  const old = await PreviousSDK.create().lifecycle.createAsset(
    [
      {
        id: "old",
        type: "text",
        content: "hello",
        contentType: "text/plain",
        hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
    ],
    { controller: "ephemeral" },
  );
  for (const allowPartial of [false, true]) {
    await expect(
      OriginalsSDK.create().lifecycle.loadAsset(old.serialize(), {
        allowPartial,
      }),
    ).rejects.toThrow();
  }
});

test("unavailable asset resolution cannot return an older cached DID document", async () => {
  const sdk = OriginalsSDK.create({ network: "regtest" });
  const did = "did:btco:reg:5000000000";
  await sdk.did.cache.set(did, {
    id: did,
    "@context": ["https://www.w3.org/ns/did/v1"],
  });
  await expect(sdk.did.resolveDID(did)).rejects.toMatchObject({
    code: "ASSET_RESOLUTION_UNAVAILABLE",
  });
});

test("root and CEL subpath expose the selected verifier and no previous asset writer", async () => {
  const root = await import("../../src/index.js");
  const cel = await import("../../src/cel/index.js");
  const asset = await OriginalsSDK.create({
    signer: createLocalSigner("P-256", new Uint8Array(32).fill(32)),
  }).lifecycle.createAsset([]);
  expect(root.verifyHistory(asset.celLog).state).toEqual(asset.state);
  expect(cel.verifyHistory(asset.celLog).state).toEqual(asset.state);
  expect(root.ASSET_ENVELOPE_VERSION).toBe(asset.serialize().version);
  for (const surface of [root, cel]) {
    for (const oldName of [
      "OriginalsCel",
      "PeerCelManager",
      "BtcoCelManager",
      "createEventLog",
      "verifyEventLog",
    ]) {
      expect(Object.hasOwn(surface, oldName)).toBe(false);
    }
  }
});
