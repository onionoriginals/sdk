import { expect, test } from "bun:test";
import { createLocalSigner } from "@originals/cel/v3";
import { OriginalsSDK } from "../../../src/index.js";

// Public fixture key and PNG from the checked-in real regtest example. Never fund.
const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(7));
const png = new Uint8Array(
  await Bun.file(
    new URL(
      "../../../../../docs/regtest/examples/content.png",
      import.meta.url,
    ),
  ).arrayBuffer(),
);
const digest = "uEiBePTgttN2D1ZqldCeTrWt5A0CehlyDvLxUg1BJ8EO8FQ";

test("creator can serialize exact PNG bytes and a fresh SDK derives the same authenticated CEL 3 state", async () => {
  const sdk = OriginalsSDK.create({ signer });
  const input = new Uint8Array(png);
  const creating = sdk.lifecycle.createAsset(
    [{ id: "art", mediaType: "image/png", content: input }],
    { name: "First edition" },
  );
  input.fill(0);
  const asset = await creating;
  expect(asset.celLog.log[0].event.operation.type).toBe("create");
  expect(asset.state.resources[0]).toMatchObject({
    id: "art",
    digestMultibase: digest,
    version: 1,
  });
  expect(await asset.verify()).toBe(true);
  const envelope = asset.serialize();
  expect(envelope.version).toBe(3);
  expect(envelope.resources[0].content.encoding).toBe("base64");
  const { asset: restored, verification } =
    await OriginalsSDK.create().lifecycle.loadAsset(JSON.stringify(envelope));
  expect(verification.verified).toBe(true);
  expect(restored.state).toEqual(asset.state);
  expect(restored.resources[0].content).toEqual(png);
  expect(await restored.verify()).toBe(true);
});

test("two retained edits survive, and retry does not silently reuse a predecessor version after equal-byte updates", async () => {
  const initial = await OriginalsSDK.create({ signer }).lifecycle.createAsset([
    { id: "art", mediaType: "text/plain", content: "same bytes" },
  ]);
  const asset = (
    await OriginalsSDK.create().lifecycle.loadAsset(initial.serialize())
  ).asset;
  const [a, b] = await Promise.all([
    asset.addResourceVersion("art", "first draft", "text/plain", {
      onAppendFailure: "skip",
    }),
    asset.addResourceVersion("art", "second draft", "text/plain", {
      onAppendFailure: "skip",
    }),
  ]);
  expect(asset.localResources).toHaveLength(2);
  await asset.addResourceVersion("art", "same bytes", "text/plain", { signer });
  await expect(
    asset.retryResourceVersion(a.localResourceId!, { signer }),
  ).rejects.toMatchObject({ code: "ASSET_LOCAL_RESOURCE_STALE" });
  expect(asset.localResources).toHaveLength(2);
  expect(asset.state.resources[0].version).toBe(2);
  await asset.discardLocalResource(a.localResourceId!);
  await asset.discardLocalResource(b.localResourceId!);
  expect(await asset.verify()).toBe(true);
});

test("binary attachments larger than the CEL metadata string limit survive object and JSON interchange", async () => {
  const content = new Uint8Array(1024 * 1024).fill(255);
  content[0] = 0;
  const sdk = OriginalsSDK.create({ signer });
  const asset = await sdk.lifecycle.createAsset([
    { id: "large", mediaType: "application/octet-stream", content },
  ]);
  const object = await sdk.lifecycle.loadAsset(asset.serialize());
  const json = await sdk.lifecycle.loadAsset(
    JSON.stringify(object.asset.serialize()),
  );
  expect(json.asset.resources[0].content).toEqual(content);
  expect(await json.asset.verify()).toBe(true);
});

test("explicitly skipped bytes stay local, fail full verification, survive an honest partial load and can be retried", async () => {
  const source = await OriginalsSDK.create({ signer }).lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: png },
  ]);
  const sdk = OriginalsSDK.create();
  const asset = (await sdk.lifecycle.loadAsset(source.serialize())).asset;
  const before = asset.state;
  const skipped = await asset.addResourceVersion(
    "art",
    new Uint8Array([255, 0, 127]),
    "application/octet-stream",
    { onAppendFailure: "skip" },
  );
  expect(skipped).toMatchObject({
    status: "skipped",
    reason: "NO_SIGNING_KEY",
  });
  expect(asset.state).toEqual(before);
  expect(asset.resources).toHaveLength(1);
  expect(asset.localResources[0].content).toEqual(
    new Uint8Array([255, 0, 127]),
  );
  expect(await asset.verify()).toBe(false);
  const encoded = JSON.stringify(asset.serialize());
  await expect(sdk.lifecycle.loadAsset(encoded)).rejects.toMatchObject({
    code: "ASSET_LOAD_VERIFICATION_FAILED",
  });
  const partial = await sdk.lifecycle.loadAsset(encoded, {
    allowPartial: true,
  });
  expect(partial.verification.verified).toBe(false);
  expect(partial.verification.history.status).toBe("authenticated");
  expect(await partial.asset.verify()).toBe(false);
  await partial.asset.retryResourceVersion(skipped.localResourceId!, {
    signer,
  });
  expect(partial.asset.localResources).toHaveLength(0);
  expect(partial.asset.resources[1].version).toBe(2);
  expect(await partial.asset.verify()).toBe(true);
  expect(
    (await sdk.lifecycle.loadAsset(partial.asset.serialize())).verification
      .verified,
  ).toBe(true);
});

test("a failed signature releases the queue and rotation retires A before the next queued author operation", async () => {
  const nextSigner = createLocalSigner("P-256", new Uint8Array(32).fill(8));
  const sdk = OriginalsSDK.create({ signer });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: png },
  ]);
  const broken = {
    ...signer,
    async sign() {
      throw new Error("custody unavailable");
    },
  };
  const failed = asset.addResourceVersion("art", "discarded", "text/plain", {
    signer: broken,
  });
  const rotated = asset.rotateKey(nextSigner.controller);
  const retired = asset.update({ name: "old key cannot do this" });
  const continued = asset.update(
    { metadata: { edition: 2 } },
    { signer: nextSigner },
  );
  const results = await Promise.allSettled([
    failed,
    rotated,
    retired,
    continued,
  ]);
  expect(results.map((r) => r.status)).toEqual([
    "rejected",
    "fulfilled",
    "rejected",
    "fulfilled",
  ]);
  expect(asset.resources).toHaveLength(1);
  expect(asset.resources[0].content).toEqual(png);
  expect(asset.state).toMatchObject({
    controller: nextSigner.controller,
    entryCount: 3,
    metadata: { edition: 2 },
  });
  expect(asset.state.name).toBeUndefined();
  const restored = (await sdk.lifecycle.loadAsset(asset.serialize())).asset;
  expect(restored.state).toEqual(asset.state);
  await expect(
    restored.deactivate("finished", { signer: nextSigner }),
  ).resolves.toMatchObject({ status: "signed" });
  await expect(
    restored.update({ name: "after end" }, { signer: nextSigner }),
  ).rejects.toMatchObject({ code: "CEL_DEACTIVATED" });
  expect(restored.state.active).toBe(false);
  expect(await restored.verify()).toBe(true);
});

test("overlapping resource versions and metadata edits keep every signed version and exact bytes", async () => {
  const sdk = OriginalsSDK.create({ signer });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: png },
  ]);
  const second = new Uint8Array([0, 255, 128, 1]);
  const third = new Uint8Array([254, 0, 129]);
  const pending = [
    asset.addResourceVersion("art", second, "application/octet-stream"),
    asset.update({ metadata: { edition: 2 } }),
    asset.addResourceVersion("art", third, "application/octet-stream"),
  ];
  second.fill(5);
  await Promise.all(pending);
  expect(asset.resources.map((r) => r.version)).toEqual([1, 2, 3]);
  expect(asset.resources[1].content).toEqual(new Uint8Array([0, 255, 128, 1]));
  expect(asset.resources[2].content).toEqual(third);
  expect(asset.state.entryCount).toBe(4);
  expect(asset.state.metadata).toEqual({ edition: 2 });
  const restored = (
    await sdk.lifecycle.loadAsset(JSON.stringify(asset.serialize()))
  ).asset;
  expect(restored.resources).toEqual(asset.resources);
  expect(restored.state).toEqual(asset.state);
});

test("overlapping allowed author updates both survive and the queued update reads the committed head", async () => {
  const sdk = OriginalsSDK.create({ signer });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: png },
  ]);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = {
    ...signer,
    async sign(bytes: Uint8Array) {
      await blocked;
      return signer.sign(bytes);
    },
  };
  const data = { metadata: { edition: 1 } };
  const first = asset.update(data, { signer: delayed });
  const second = asset.update({ name: "Edition one" });
  data.metadata.edition = 99;
  expect(asset.celLog.log).toHaveLength(1);
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a.status).toBe("signed");
  expect(b.status).toBe("signed");
  expect(asset.celLog.log).toHaveLength(3);
  expect(asset.celLog.log[2].event.previousEvent).toBe(a.head);
  expect(asset.state).toMatchObject({
    name: "Edition one",
    metadata: { edition: 1 },
    head: b.head,
  });
  const { asset: restored } = await sdk.lifecycle.loadAsset(asset.serialize());
  expect(restored.state).toEqual(asset.state);
});
