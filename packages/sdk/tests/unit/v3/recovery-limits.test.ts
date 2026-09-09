import { expect, test } from "bun:test";
import {
  ASSET_LIMITS,
  OriginalsSDK,
  createLocalSigner,
} from "../../../src/index.js";

const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(14));

test("a long profile-valid resource id can retain, serialize, load and retry unsigned bytes", async () => {
  const id = "x".repeat(9000),
    reader = OriginalsSDK.create();
  const created = await OriginalsSDK.create({ signer }).lifecycle.createAsset([
    { id, mediaType: "text/plain", content: "original" },
  ]);
  const asset = (await reader.lifecycle.loadAsset(created.serialize())).asset;
  const skipped = await asset.addResourceVersion(id, "draft", "text/plain", {
    onAppendFailure: "skip",
  });
  expect(skipped.status).toBe("skipped");
  const restored = await reader.lifecycle.loadAsset(
    JSON.stringify(asset.serialize()),
    { allowPartial: true },
  );
  if (skipped.status !== "skipped") throw new Error("Expected retained draft");
  await restored.asset.retryResourceVersion(skipped.localResourceId!, {
    signer,
  });
  expect(await restored.asset.verify()).toBe(true);
});

test("attachment-count exhaustion rejects before acknowledging an edit and leaves recovery and the queue usable", async () => {
  const reader = OriginalsSDK.create();
  const created = await OriginalsSDK.create({ signer }).lifecycle.createAsset([
    { id: "r", mediaType: "text/plain", content: "" },
  ]);
  const env = created.serialize();
  env.unverified = {
    localResources: Array.from(
      { length: ASSET_LIMITS.attachments - 1 },
      (_, i) => ({
        localResourceId: String(i),
        id: "r",
        mediaType: "text/plain",
        baseDigestMultibase: env.resources[0].digestMultibase,
        baseVersion: 1,
        content: { encoding: "base64" as const, data: "" },
      }),
    ),
  };
  const asset = (await reader.lifecycle.loadAsset(env, { allowPartial: true }))
    .asset;
  await expect(
    asset.addResourceVersion("r", "", "text/plain", {
      onAppendFailure: "skip",
    }),
  ).rejects.toMatchObject({ code: "ASSET_ATTACHMENTS_LIMIT" });
  expect(asset.serialize().unverified!.localResources).toHaveLength(
    ASSET_LIMITS.attachments - 1,
  );
  const restored = await reader.lifecycle.loadAsset(
    JSON.stringify(asset.serialize()),
    { allowPartial: true },
  );
  expect(restored.asset.localResources).toHaveLength(
    ASSET_LIMITS.attachments - 1,
  );
  await asset.discardLocalResource("0");
  await expect(
    asset.addResourceVersion("r", "", "text/plain", {
      onAppendFailure: "skip",
    }),
  ).resolves.toMatchObject({ status: "skipped" });
  expect(asset.serialize().unverified!.localResources).toHaveLength(
    ASSET_LIMITS.attachments - 1,
  );
}, 60_000);

test("aggregate input bytes are rejected before later inputs are processed", async () => {
  const large = new Uint8Array(17 * 1024 * 1024);
  await expect(
    OriginalsSDK.create({ signer }).lifecycle.createAsset([
      { id: "a", mediaType: "application/octet-stream", content: large },
      { id: "b", mediaType: "application/octet-stream", content: large },
      null as never,
    ]),
  ).rejects.toMatchObject({ code: "ASSET_BYTES_LIMIT" });
});

test("aggregate envelope bytes are rejected before later attachments are decoded or inspected", async () => {
  const created = await OriginalsSDK.create({ signer }).lifecycle.createAsset([
    { id: "r", mediaType: "text/plain", content: "ok" },
  ]);
  const env = created.serialize(),
    content = {
      encoding: "base64" as const,
      data: "AAAA".repeat(Math.ceil((17 * 1024 * 1024) / 3)),
    };
  env.resources = [
    { ...env.resources[0], content },
    { ...env.resources[0], content },
    null as never,
  ];
  await expect(
    OriginalsSDK.create().lifecycle.loadAsset(env, { allowPartial: true }),
  ).rejects.toMatchObject({ code: "ASSET_BYTES_LIMIT" });
});
