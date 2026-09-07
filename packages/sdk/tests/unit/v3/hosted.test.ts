import { expect, test } from "bun:test";
import { OriginalsSDK } from "../../../src/index.js";
import { createLocalSigner } from "@originals/cel/v3";
import type { StorageAdapter } from "../../../src/storage/StorageAdapter.js";
const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(21));
function storage(): StorageAdapter {
  const files = new Map<
    string,
    { content: Uint8Array; contentType?: string }
  >();
  return {
    async putObject(domain, path, bytes, options) {
      files.set(domain + "/" + path, {
        content:
          typeof bytes === "string"
            ? new TextEncoder().encode(bytes)
            : new Uint8Array(bytes),
        contentType: options?.contentType,
      });
      return "https://" + domain + "/" + path;
    },
    async getObject(domain, path) {
      const file = files.get(domain + "/" + path);
      return file ? { ...file, content: new Uint8Array(file.content) } : null;
    },
    async exists(domain, path) {
      return files.has(domain + "/" + path);
    },
  };
}
test("publish and cold hosted loading preserve CEL 3, separate WebVH method history and exact PNG bytes", async () => {
  const store = storage(),
    png = new Uint8Array([137, 80, 78, 71, 0, 255]);
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: png },
  ]);
  const published = await sdk.lifecycle.publishToWeb(asset, {
    domain: "example.com",
  });
  expect(published.asset.state.layer).toBe("webvh");
  expect(published.did).toContain(":example.com:published:anonymous:");
  const fresh = OriginalsSDK.create({ storageAdapter: store });
  const loaded = await fresh.lifecycle.resolveAssetFromWeb(published.did);
  expect(loaded.asset.id).toBe(asset.id);
  expect(loaded.asset.resources[0].content).toEqual(png);
  expect(loaded.verification.verified).toBe(true);
  expect(await loaded.asset.verify()).toBe(true);
});

test("republishing updated resource bytes retains the same hosted identity and all historical versions", async () => {
  const store = storage(),
    sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const original = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: new Uint8Array([1, 2]) },
  ]);
  const first = await sdk.lifecycle.publishToWeb(original, {
    domain: "example.com",
  });
  await first.asset.addResourceVersion(
    "art",
    new Uint8Array([3, 4]),
    "image/png",
  );
  const second = await sdk.lifecycle.publishToWeb(first.asset, {
    domain: "example.com",
  });
  expect(second.did).toBe(first.did);
  const loaded = await OriginalsSDK.create({
    storageAdapter: store,
  }).lifecycle.resolveAssetFromWeb(first.did);
  expect(loaded.asset.resources.map((r) => [...r.content!])).toEqual([
    [1, 2],
    [3, 4],
  ]);
  expect(loaded.verification.verified).toBe(true);
});

test("a failed upload retries the identical prepared publication and substituted media never verifies", async () => {
  const inner = storage();
  let fail = true;
  const store: StorageAdapter = {
    ...inner,
    async putObject(domain, path, bytes, options) {
      if (fail && path.endsWith("cel.json")) throw new Error("connection lost");
      return inner.putObject(domain, path, bytes, options);
    },
  };
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: new Uint8Array([8, 9]) },
  ]);
  const prepared = await sdk.lifecycle.prepareWebPublication(asset, {
    domain: "example.com",
  });
  await expect(sdk.lifecycle.publishPreparedToWeb(prepared)).rejects.toThrow(
    "retry this same",
  );
  expect(asset.state.layer).toBe("cel");
  fail = false;
  const published = await sdk.lifecycle.publishPreparedToWeb(
    JSON.parse(JSON.stringify(prepared)),
  );
  expect(published.did).toBe(prepared.did);
  expect(await published.asset.verify()).toBe(true);
  const resource = published.asset.resources[0];
  await inner.putObject(
    "example.com",
    "published/anonymous/" +
      asset.id.slice(8) +
      "/resources/" +
      resource.digestMultibase,
    new Uint8Array([0]),
    { contentType: "image/png" },
  );
  expect(await published.asset.verify()).toBe(false);
  await expect(
    sdk.lifecycle.resolveAssetFromWeb(published.did),
  ).rejects.toThrow();
});

test("publication refuses an omitted domain before invoking custody or storage", async () => {
  const sdk = OriginalsSDK.create({ signer, storageAdapter: storage() });
  const asset = await sdk.lifecycle.createAsset([]);
  await expect(sdk.lifecycle.publishToWeb(asset, {} as never)).rejects.toThrow(
    "domain",
  );
  const published = await sdk.lifecycle.publishToWeb(asset, {
    domain: "example.com",
  });
  expect(
    (await sdk.lifecycle.resolveAssetFromWeb(published.did)).verification
      .verified,
  ).toBe(true);
});

test('equal resource bytes with different signed media types round-trip without colliding transport metadata', async () => {
  const sdk = OriginalsSDK.create({ signer, storageAdapter: storage() });
  const asset = await sdk.lifecycle.createAsset([
    { id: 'text', mediaType: 'text/plain', content: 'hello' },
    { id: 'bytes', mediaType: 'application/octet-stream', content: 'hello' },
  ]);
  const published = await sdk.lifecycle.publishToWeb(asset, { domain: 'example.com' });
  const loaded = await sdk.lifecycle.resolveAssetFromWeb(published.did);
  expect(loaded.asset.resources.map(r => r.mediaType)).toEqual(['text/plain', 'application/octet-stream']);
  expect(loaded.verification.verified).toBe(true);
});

test('a terminal hosted history can be published and remains deactivated for fresh consumers', async () => {
  const sdk = OriginalsSDK.create({ signer, storageAdapter: storage() });
  const initial = await sdk.lifecycle.publishToWeb(await sdk.lifecycle.createAsset([]), { domain: 'example.com' });
  await initial.asset.deactivate('retired');
  await sdk.lifecycle.publishToWeb(initial.asset, { domain: 'example.com' });
  const loaded = await sdk.lifecycle.resolveAssetFromWeb(initial.did);
  expect(loaded.asset.state.active).toBe(false);
  expect(loaded.verification.verified).toBe(true);
});
