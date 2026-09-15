import { fetchPublicReachabilityCheck } from '../../../src/v3/hosted.js';
import { expect, test } from "bun:test";
import { OriginalsSDK } from "../../../src/index.js";
import { CelError, createLocalSigner, assetDigest } from "@originals/cel/v3";
import { StructuredError } from "@originals/cel";
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

test.each(["", "   ", "\t"])(
  "publishToWeb rejects a blank/whitespace-only domain (%j) with WEBVH_DOMAIN_REQUIRED, before any signing work (#678)",
  async (domain) => {
    const store = storage();
    const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
    const asset = await sdk.lifecycle.createAsset([
      { id: "art", mediaType: "image/png", content: new Uint8Array([1]) },
    ]);
    let thrown: unknown;
    try {
      await sdk.lifecycle.publishToWeb(asset, { domain });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CelError);
    expect((thrown as CelError).code).toBe("WEBVH_DOMAIN_REQUIRED");
  },
);

// #722: a mixed-case domain is a perfectly valid, commonly-typed hostname —
// DNS is case-insensitive — but the raw string used to fail deep inside CEL
// history verification with a confusing CEL_DID error instead of publishing.
test("publishToWeb normalizes a mixed-case first-publish domain instead of failing with CEL_DID (#722)", async () => {
  const store = storage();
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: new Uint8Array([1]) },
  ]);
  const published = await sdk.lifecycle.publishToWeb(asset, {
    domain: "Example.COM",
  });
  expect(published.did).toContain(":example.com:");
  expect(published.did).not.toContain("Example.COM");
  const loaded = await sdk.lifecycle.resolveAssetFromWeb(published.did);
  expect(loaded.verification.verified).toBe(true);
});

// #764: padded-but-nonblank input must not mint a DID with embedded
// whitespace — it is canonicalized (trimmed) the same as case is normalized.
test("publishToWeb trims a padded first-publish domain instead of embedding whitespace in the DID (#764)", async () => {
  const store = storage();
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: new Uint8Array([1]) },
  ]);
  const published = await sdk.lifecycle.publishToWeb(asset, {
    domain: "  example.com  ",
  });
  expect(published.did).toContain(":example.com:");
  expect(published.did).not.toContain(" ");
  expect(published.did).not.toContain("%20");
});

// #764 (malformed, nonblank): a domain that is not a usable host once
// trimmed must fail at this seam with a domain-specific error, not mint a
// broken DID and not surface an unrelated low-level failure later.
test("publishToWeb rejects a malformed nonblank domain at the hosted seam instead of minting a broken DID", async () => {
  const store = storage();
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: new Uint8Array([1]) },
  ]);
  let thrown: unknown;
  try {
    await sdk.lifecycle.publishToWeb(asset, { domain: "not a domain" });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(CelError);
  expect((thrown as CelError).code).toBe("INVALID_DOMAIN");
});

// #761: republishing to the same host must succeed regardless of the
// caller's letter case, since the existing hosted identity's stored domain
// is always the lower-cased `URL#host` form.
test("publishToWeb accepts a differently-cased but equivalent domain on republish (#761)", async () => {
  const store = storage();
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: new Uint8Array([1]) },
  ]);
  const first = await sdk.lifecycle.publishToWeb(asset, { domain: "example.com" });
  await first.asset.addResourceVersion("art", new Uint8Array([2]), "image/png");
  const second = await sdk.lifecycle.publishToWeb(first.asset, { domain: "Example.com" });
  expect(second.did).toBe(first.did);
  const loaded = await sdk.lifecycle.resolveAssetFromWeb(second.did);
  expect(loaded.verification.verified).toBe(true);
});

// #761 (still enforced): a republish naming a genuinely different host must
// still be rejected — normalization must not weaken the permanent-binding check.
test("publishToWeb still rejects a republish naming a different host as ASSET_WEBVH_BINDING", async () => {
  const store = storage();
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: new Uint8Array([1]) },
  ]);
  const first = await sdk.lifecycle.publishToWeb(asset, { domain: "example.com" });
  let thrown: unknown;
  try {
    await sdk.lifecycle.publishToWeb(first.asset, { domain: "other.example.com" });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(CelError);
  expect((thrown as CelError).code).toBe("ASSET_WEBVH_BINDING");
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

test("republishing after rotating the controller to P-256 succeeds without a separate Ed25519 webvhSigner", async () => {
  const store = storage();
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: new Uint8Array([1, 2]) },
  ]);
  const published = await sdk.lifecycle.publishToWeb(asset, {
    domain: "example.com",
  });
  const p256Signer = createLocalSigner("P-256", new Uint8Array(32).fill(7));
  await published.asset.rotateKey(p256Signer.controller, { signer });
  await published.asset.addResourceVersion(
    "art",
    new Uint8Array([3, 4]),
    "image/png",
    { signer: p256Signer },
  );
  // The republish path never touches the WebVH method log, so the P-256
  // controller signer alone is sufficient; no webvhSigner is supplied.
  const republished = await sdk.lifecycle.publishToWeb(published.asset, {
    domain: "example.com",
    signer: p256Signer,
  });
  expect(republished.did).toBe(published.did);
  const loaded = await OriginalsSDK.create({
    storageAdapter: store,
  }).lifecycle.resolveAssetFromWeb(published.did);
  expect(loaded.verification.verified).toBe(true);
  expect(loaded.asset.resources.map((r) => [...r.content!])).toEqual([
    [1, 2],
    [3, 4],
  ]);
});

test("republishing after rotating the controller to P-384 succeeds without a separate Ed25519 webvhSigner", async () => {
  const store = storage();
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: new Uint8Array([1, 2]) },
  ]);
  const published = await sdk.lifecycle.publishToWeb(asset, {
    domain: "example.com",
  });
  const p384Signer = createLocalSigner("P-384", new Uint8Array(48).fill(7));
  await published.asset.rotateKey(p384Signer.controller, { signer });
  await published.asset.addResourceVersion(
    "art",
    new Uint8Array([3, 4]),
    "image/png",
    { signer: p384Signer },
  );
  const republished = await sdk.lifecycle.publishToWeb(published.asset, {
    domain: "example.com",
    signer: p384Signer,
  });
  expect(republished.did).toBe(published.did);
});

test("a first-time WebVH publication with a non-Ed25519 controller signer still requires an explicit Ed25519 webvhSigner", async () => {
  const p256Signer = createLocalSigner("P-256", new Uint8Array(32).fill(9));
  const sdk = OriginalsSDK.create({
    signer: p256Signer,
    storageAdapter: storage(),
  });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: new Uint8Array([1, 2]) },
  ]);
  await expect(
    sdk.lifecycle.publishToWeb(asset, { domain: "example.com" }),
  ).rejects.toThrow("Ed25519");
  const published = await sdk.lifecycle.publishToWeb(asset, {
    domain: "example.com",
    webvhSigner: signer,
  });
  expect(published.asset.state.layer).toBe("webvh");
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

// Greptile review on #754: retryability must be decided by where a failure
// originates (the storage round trip), not by which error class the adapter
// happens to throw. A custom adapter is free to throw its own StructuredError
// for a transient condition (e.g. a rate limit); that must still be wrapped
// as the recoverable ASSET_WEB_PUBLISH_INCOMPLETE with `details.publication`,
// not rethrown bare and stripped of the retry contract.
test("a storage adapter's own StructuredError for a transient failure is still wrapped with the recoverable prepared publication", async () => {
  const inner = storage();
  let fail = true;
  const store: StorageAdapter = {
    ...inner,
    async putObject(domain, path, bytes, options) {
      if (fail && path.endsWith("cel.json"))
        throw new StructuredError("RATE_LIMITED", "Too many requests");
      return inner.putObject(domain, path, bytes, options);
    },
  };
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: new Uint8Array([5, 6]) },
  ]);
  const prepared = await sdk.lifecycle.prepareWebPublication(asset, {
    domain: "example.com",
  });
  const failure = await sdk.lifecycle
    .publishPreparedToWeb(prepared)
    .catch((err) => err);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as { code?: string }).code).toBe(
    "ASSET_WEB_PUBLISH_INCOMPLETE",
  );
  expect((failure as { details?: { publication?: unknown } }).details?.publication).toBeDefined();
  fail = false;
  const published = await sdk.lifecycle.publishPreparedToWeb(
    (failure as { details: { publication: typeof prepared } }).details
      .publication,
  );
  expect(published.did).toBe(prepared.did);
});

// #739: missing historical resource bytes is a permanent, non-retryable
// defect, not a storage I/O failure. It must be reported as its own
// ASSET_RESOURCE_MISSING error, both at prepare time (before signing) and
// again at publish time (before any writes), never rewrapped as the
// retryable ASSET_WEB_PUBLISH_INCOMPLETE the storage-failure catch produces.
test("prepareWebPublication rejects an asset missing historical resource bytes before signing anything", async () => {
  const store = storage();
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const created = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "text/plain", content: "v1" },
  ]);
  await created.addResourceVersion("art", "v2", "text/plain", { signer });
  const env = created.serialize();
  env.resources = env.resources.filter((r: { version: number }) => r.version !== 1);
  const reloaded = await OriginalsSDK.create({
    storageAdapter: store,
  }).lifecycle.loadAsset(env, { allowPartial: true });
  expect(reloaded.verification.verified).toBe(false);
  await expect(
    sdk.lifecycle.prepareWebPublication(reloaded.asset, { domain: "example.com" }),
  ).rejects.toThrow("Supply every historical resource");
});

test("publishPreparedToWeb rejects missing historical resource bytes as ASSET_RESOURCE_MISSING, not a retryable storage failure, and writes nothing", async () => {
  const store = storage();
  let writes = 0;
  const put = store.putObject.bind(store);
  store.putObject = async (...args) => {
    writes++;
    return put(...args);
  };
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const created = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "text/plain", content: "v1" },
  ]);
  await created.addResourceVersion("art", "v2", "text/plain", { signer });
  const prepared = await sdk.lifecycle.prepareWebPublication(created, {
    domain: "example.com",
  });
  // Simulate an incomplete prepared publication (e.g. built from an
  // allowPartial-loaded asset) by dropping a historical resource attachment;
  // its catalog entry stays authenticated but binds to no bytes.
  prepared.asset.resources = prepared.asset.resources.filter(
    (r) => r.version !== 1,
  );
  const failure = await sdk.lifecycle
    .publishPreparedToWeb(prepared)
    .catch((err) => err);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as { code?: string }).code).toBe("ASSET_RESOURCE_MISSING");
  expect((failure as Error).message).not.toContain("retry this same");
  expect(writes).toBe(0);
});

test("a wrong adapter-returned storage URL propagates as ASSET_STORAGE_URL, not a retryable publish failure", async () => {
  const inner = storage();
  const store: StorageAdapter = {
    ...inner,
    async putObject(domain, path, bytes, options) {
      await inner.putObject(domain, path, bytes, options);
      return "https://wrong-host.example/" + path;
    },
  };
  const sdk = OriginalsSDK.create({ signer, storageAdapter: store });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "text/plain", content: "v1" },
  ]);
  const failure = await sdk.lifecycle
    .publishToWeb(asset, { domain: "example.com" })
    .catch((err) => err);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as { code?: string }).code).toBe("ASSET_STORAGE_URL");
  expect((failure as Error).message).not.toContain("retry this same");
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

// #601: a private/in-memory adapter can satisfy the storage interface without the
// advertised HTTPS URL being reachable from anywhere else. Without an independent
// check, publication must say so honestly rather than implying public reachability.
test('publication is labeled adapter-asserted by default; an independent publicReachability check upgrades the label', async () => {
  const store = storage();
  const unchecked = OriginalsSDK.create({ signer, storageAdapter: store });
  const bareResult = await unchecked.lifecycle.publishToWeb(
    await unchecked.lifecycle.createAsset([]),
    { domain: 'example.com' },
  );
  expect(bareResult.hostingEvidence).toBe('adapter-asserted');

  const checked = OriginalsSDK.create({
    signer,
    storageAdapter: store,
    // A real deployment would fetch this over the network, independent of `store`.
    // This test only exercises the resulting content-matching/labeling logic.
    publicReachability: async (url) => {
      const path = new URL(url).pathname.slice(1);
      const file = await store.getObject('example.com', path);
      return file?.content ?? null;
    },
  });
  const verifiedResult = await checked.lifecycle.publishToWeb(
    await checked.lifecycle.createAsset([]),
    { domain: 'example.com' },
  );
  expect(verifiedResult.hostingEvidence).toBe('independently-verified');
});

test('requirePublicReachability without a configured check refuses before any writes', async () => {
  const store = storage();
  let writes = 0;
  const put = store.putObject.bind(store);
  store.putObject = async (...args) => { writes++; return put(...args); };
  const sdk = OriginalsSDK.create({
    signer,
    storageAdapter: store,
    requirePublicReachability: true,
  });
  await expect(
    sdk.lifecycle.publishToWeb(await sdk.lifecycle.createAsset([]), {
      domain: 'example.com',
    }),
  ).rejects.toThrow(/publicReachability check/);
  expect(writes).toBe(0);
});

test('requirePublicReachability fails closed while hosting is unreachable, and the identical prepared publication succeeds once it is not', async () => {
  const store = storage();
  let publiclyReachable = false;
  const sdk = OriginalsSDK.create({
    signer,
    storageAdapter: store,
    requirePublicReachability: true,
    publicReachability: async (url) => {
      if (!publiclyReachable) return null;
      const path = new URL(url).pathname.slice(1);
      const file = await store.getObject('example.com', path);
      return file?.content ?? null;
    },
  });
  const asset = await sdk.lifecycle.createAsset([]);
  const prepared = await sdk.lifecycle.prepareWebPublication(asset, {
    domain: 'example.com',
  });
  await expect(sdk.lifecycle.publishPreparedToWeb(prepared)).rejects.toThrow(
    'not independently reachable',
  );
  // No public evidence was ever obtained; the asset must stay unpublished locally.
  expect(asset.state.layer).toBe('cel');
  publiclyReachable = true;
  const published = await sdk.lifecycle.publishPreparedToWeb(
    JSON.parse(JSON.stringify(prepared)),
  );
  expect(published.hostingEvidence).toBe('independently-verified');
});

test('a well-formed but mismatched public log fails closed under requirePublicReachability rather than passing on shape alone', async () => {
  const decoyStore = storage();
  const decoySdk = OriginalsSDK.create({ signer, storageAdapter: decoyStore });
  const decoy = await decoySdk.lifecycle.prepareWebPublication(
    await decoySdk.lifecycle.createAsset([]),
    { domain: 'example.com' },
  );
  const decoyLog = new TextEncoder().encode(
    decoy.didLog.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );

  const sdk = OriginalsSDK.create({
    signer,
    storageAdapter: storage(),
    requirePublicReachability: true,
    // Reachable, well-formed WebVH log — just not the one that was just published.
    publicReachability: async () => decoyLog,
  });
  await expect(
    sdk.lifecycle.publishToWeb(await sdk.lifecycle.createAsset([]), {
      domain: 'example.com',
    }),
  ).rejects.toThrow('not independently reachable');
});

// A log that still resolves to the SAME DID and asset binding is not
// necessarily *this* publication — a stale cached copy would resolve just
// as validly. The check must compare exact published bytes, not merely
// "does this independently resolve to the right DID", or a stale-but-genuine
// public copy would be labeled independently-verified.
test('a byte-different copy of this exact DID and asset fails closed even though it independently resolves fine', async () => {
  const store = storage();
  let publicBytes: Uint8Array | null = null;
  const sdk = OriginalsSDK.create({
    signer,
    storageAdapter: store,
    requirePublicReachability: true,
    publicReachability: async () => publicBytes,
  });
  const asset = await sdk.lifecycle.createAsset([]);
  const prepared = await sdk.lifecycle.prepareWebPublication(asset, {
    domain: 'example.com',
  });
  // Stale by exactly one trailing byte: still the same DID, still a
  // validly resolving log, still bound to the same asset genesis.
  publicBytes = new TextEncoder().encode(
    prepared.didLog.map((entry) => JSON.stringify(entry)).join('\n') + '\n\n',
  );
  await expect(sdk.lifecycle.publishPreparedToWeb(prepared)).rejects.toThrow(
    'not independently reachable',
  );
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


test('the public checker omits credentials and cached responses and refuses redirects', async () => {
  const realFetch = globalThis.fetch;
  let requested: RequestInit | undefined;
  globalThis.fetch = (async (_url, init) => {
    requested = init;
    return new Response('public log');
  }) as typeof fetch;
  try {
    await fetchPublicReachabilityCheck('https://example.com/did.jsonl');
    expect(requested?.credentials).toBe('omit');
    expect(requested?.cache).toBe('no-store');
    expect(requested?.redirect).toBe('error');
  } finally {
    globalThis.fetch = realFetch;
  }
});
