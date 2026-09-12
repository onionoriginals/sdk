import { expect, test } from "bun:test";
import { OriginalsSDK } from "../../../src/index.js";
import { fetchPublicReachabilityCheck } from "../../../src/v3/hosted.js";
import { createLocalSigner, assetDigest } from "@originals/cel/v3";
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
      assetDigest(asset.id) +
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

// #601: a private/in-memory storage adapter can satisfy the same-adapter
// read-back without the advertised DID log ever being reachable on the
// public web. hostingEvidence and requirePublicReachability make that
// distinction explicit instead of reporting an unqualified 'published'.
test('publication defaults to adapter-asserted evidence with no reachability check configured', async () => {
  const sdk = OriginalsSDK.create({ signer, storageAdapter: storage() });
  const asset = await sdk.lifecycle.createAsset([]);
  const published = await sdk.lifecycle.publishToWeb(asset, { domain: 'example.com' });
  expect(published.hostingEvidence).toBe('adapter-asserted');
});

test('a configured reachability check that matches the published bytes upgrades evidence to independently-verified', async () => {
  const store = storage();
  const sdk = OriginalsSDK.create({
    signer,
    storageAdapter: store,
    publicReachability: async (url) => {
      const [domain, ...rest] = url.replace('https://', '').split('/');
      const object = await store.getObject(domain, rest.join('/'));
      return object?.content ?? null;
    },
  });
  const asset = await sdk.lifecycle.createAsset([]);
  const published = await sdk.lifecycle.publishToWeb(asset, { domain: 'example.com' });
  expect(published.hostingEvidence).toBe('independently-verified');
});

test('requirePublicReachability fails closed, preserving the prepared publication for retry, when no checker is configured', async () => {
  const sdk = OriginalsSDK.create({
    signer,
    storageAdapter: storage(),
    requirePublicReachability: true,
  });
  const asset = await sdk.lifecycle.createAsset([]);
  const prepared = await sdk.lifecycle.prepareWebPublication(asset, { domain: 'example.com' });
  await expect(sdk.lifecycle.publishPreparedToWeb(prepared)).rejects.toThrow(
    'publicReachability',
  );
});

test('requirePublicReachability fails closed when the public URL is unreachable, and succeeds once it is', async () => {
  const store = storage();
  let reachable = false;
  const sdk = OriginalsSDK.create({
    signer,
    storageAdapter: store,
    requirePublicReachability: true,
    publicReachability: async (url) => {
      if (!reachable) return null;
      const [domain, ...rest] = url.replace('https://', '').split('/');
      const object = await store.getObject(domain, rest.join('/'));
      return object?.content ?? null;
    },
  });
  const asset = await sdk.lifecycle.createAsset([]);
  const prepared = await sdk.lifecycle.prepareWebPublication(asset, { domain: 'example.com' });
  await expect(
    sdk.lifecycle.publishPreparedToWeb(JSON.parse(JSON.stringify(prepared))),
  ).rejects.toThrow('not independently reachable');
  expect(asset.state.layer).toBe('cel');
  reachable = true;
  const published = await sdk.lifecycle.publishPreparedToWeb(
    JSON.parse(JSON.stringify(prepared)),
  );
  expect(published.hostingEvidence).toBe('independently-verified');
});

test('requirePublicReachability rejects bytes at the public URL that do not match what was just published', async () => {
  const sdk = OriginalsSDK.create({
    signer,
    storageAdapter: storage(),
    requirePublicReachability: true,
    publicReachability: async () => new TextEncoder().encode('not the real did log'),
  });
  const asset = await sdk.lifecycle.createAsset([]);
  await expect(
    sdk.lifecycle.publishToWeb(asset, { domain: 'example.com' }),
  ).rejects.toThrow('not independently reachable');
});

// fetchPublicReachabilityCheck itself: a real HTTPS GET, never through the
// storage adapter. It must reject an oversized response by streaming and
// capping bytes as they arrive rather than buffering an unbounded body in
// full first (the same stream-before-allocation class of bug as #606).
test('fetchPublicReachabilityCheck returns the exact bytes for a small reachable response', async () => {
  const realFetch = globalThis.fetch;
  const body = new TextEncoder().encode('hello did log');
  globalThis.fetch = (async () =>
    new Response(body, { status: 200 })) as typeof fetch;
  try {
    const result = await fetchPublicReachabilityCheck('https://example.com/did.jsonl');
    expect(result).toEqual(body);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchPublicReachabilityCheck returns null without buffering a body that streams past the cap', async () => {
  const realFetch = globalThis.fetch;
  let cancelled = false;
  let enqueuedChunks = 0;
  const CHUNK = new Uint8Array(1024 * 1024).fill(1); // 1 MiB per chunk, cap is 2 MiB
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      enqueuedChunks++;
      controller.enqueue(CHUNK); // never signals done — an unbounded/hostile body
    },
    cancel() {
      cancelled = true;
    },
  });
  globalThis.fetch = (async () =>
    new Response(stream, { status: 200 })) as typeof fetch; // no Content-Length header
  try {
    const result = await fetchPublicReachabilityCheck('https://example.com/did.jsonl');
    expect(result).toBeNull();
    // Cancelled after only a few MiB, not read until Bun's own test timeout.
    expect(cancelled).toBe(true);
    expect(enqueuedChunks).toBeLessThan(10);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchPublicReachabilityCheck rejects a Content-Length that already exceeds the cap', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "content-length": String(100 * 1024 * 1024) },
    })) as typeof fetch;
  try {
    const result = await fetchPublicReachabilityCheck('https://example.com/did.jsonl');
    expect(result).toBeNull();
  } finally {
    globalThis.fetch = realFetch;
  }
});
