import { expect, test } from "bun:test";
import { OriginalsSDK, createLocalSigner } from "../../../src/index.js";

const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(11));
async function original() {
  const sdk = OriginalsSDK.create({ signer });
  const asset = await sdk.lifecycle.createAsset([
    { id: "text", mediaType: "text/plain", content: "version one" },
  ]);
  await asset.addResourceVersion("text", "version two", "text/plain");
  return { sdk, asset };
}

test.each([
  [
    "wrong id",
    (env: any) => {
      env.resources[1].id = "other";
    },
  ],
  [
    "wrong version",
    (env: any) => {
      env.resources[1].version = 1;
    },
  ],
  [
    "unproven version",
    (env: any) => {
      env.resources[1].version = 99;
    },
  ],
  [
    "wrong digest",
    (env: any) => {
      env.resources[1].digestMultibase = env.resources[0].digestMultibase;
    },
  ],
  [
    "different bytes",
    (env: any) => {
      env.resources[1].content.data = "Zm9yZ2Vk";
    },
  ],
  [
    "duplicate attachment",
    (env: any) => {
      env.resources.push(env.resources[1]);
    },
  ],
  [
    "UTF-8 envelope string",
    (env: any) => {
      env.resources[1].content = "version two";
    },
  ],
  [
    "extra attachment claim",
    (env: any) => {
      env.resources[1].verified = true;
    },
  ],
  [
    "unsafe numeric version",
    (env: any) => {
      env.resources[1].version = 9007199254740992;
    },
  ],
  [
    "forged signature",
    (env: any) => {
      env.eventLog.log[1].event.operation.data.resources[0].mediaType =
        "image/png";
    },
  ],
])(
  "load rejects %s even when partial bytes are allowed",
  async (_label, change) => {
    const { sdk, asset } = await original();
    const envelope = asset.serialize();
    change(envelope);
    await expect(
      sdk.lifecycle.loadAsset(envelope, { allowPartial: true }),
    ).rejects.toBeDefined();
    expect(await asset.verify()).toBe(true);
  },
);

test("missing claimed bytes yield the same qualified result for a loaded and in-memory asset", async () => {
  const { sdk, asset } = await original();
  const envelope = asset.serialize();
  envelope.resources.pop();
  await expect(sdk.lifecycle.loadAsset(envelope)).rejects.toMatchObject({
    code: "ASSET_LOAD_VERIFICATION_FAILED",
  });
  const loaded = await sdk.lifecycle.loadAsset(envelope, {
    allowPartial: true,
  });
  expect(loaded.verification).toMatchObject({
    verified: false,
    resources: "incomplete",
    missingResources: [{ id: "text", version: 2 }],
  });
  expect(await loaded.asset.verification()).toEqual(loaded.verification);
  expect(await loaded.asset.verify()).toBe(false);
});

test("creation rejects data getters without executing them", async () => {
  let calls = 0;
  const resource = {
    id: "text",
    mediaType: "text/plain",
    get content() {
      calls++;
      return "secret";
    },
  };
  await expect(
    OriginalsSDK.create({ signer }).lifecycle.createAsset([resource]),
  ).rejects.toMatchObject({ code: "ASSET_SHAPE" });
  expect(calls).toBe(0);
});

test.each([
  "null",
  "[]",
  '{"format":"originals/asset","version":3,"version":2}',
  '{"format":"originals/asset","version":3,"\\u0076ersion":3}',
])("malformed/ambiguous envelope is rejected: %s", async (text) => {
  await expect(
    OriginalsSDK.create().lifecycle.loadAsset(text, { allowPartial: true }),
  ).rejects.toBeDefined();
});

test("returned documents, metadata and buffers cannot mutate authenticated state", async () => {
  const { sdk, asset } = await original();
  const before = asset.serialize();
  const envelope = asset.serialize();
  envelope.eventLog.log[0].event.operation.data.profile = "other" as any;
  asset.resources[0].content!.fill(0);
  asset.celLog.log.pop();
  expect(() => {
    (asset.state as any).controller = signer.controller;
  }).toThrow();
  expect(asset.serialize()).toEqual(before);
  expect((await sdk.lifecycle.loadAsset(before)).verification.verified).toBe(
    true,
  );
});

test("duplicate decoded keys inside signed metadata cannot be hidden by envelope JSON parsing", async () => {
  const { sdk, asset } = await original();
  await asset.update({ metadata: { edition: 2 } });
  const envelope = JSON.stringify(asset.serialize()).replace(
    '"edition":2',
    '"edition":1,"\\u0065dition":2',
  );
  await expect(
    sdk.lifecycle.loadAsset(envelope, { allowPartial: true }),
  ).rejects.toMatchObject({ code: "ASSET_DUPLICATE_KEY" });
});

test("invalid public options and null updates fail before custody with structured errors", async () => {
  const { asset } = await original();
  await expect(asset.update(null as any)).rejects.toMatchObject({
    code: "ASSET_SHAPE",
  });
  await expect(
    OriginalsSDK.create().lifecycle.loadAsset(asset.serialize(), {
      allowPartial: "yes",
    } as any),
  ).rejects.toMatchObject({ code: "ASSET_OPTIONS" });
  let calls = 0;
  const custody = {
    ...signer,
    async sign(message: Uint8Array) {
      calls++;
      return signer.sign(message);
    },
  };
  await expect(
    asset.rotateKey(signer.controller, { signer: custody }),
  ).rejects.toMatchObject({ code: "CEL_ROTATION" });
  expect(calls).toBe(0);
});
