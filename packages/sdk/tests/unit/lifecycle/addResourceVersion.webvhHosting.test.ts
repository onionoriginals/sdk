import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { hashResource } from '../../../src/utils/validation';
import { encodeBase64UrlMultibase, hexToBytes } from '@originals/cel/encoding';
import { resourcePathSegment } from '@originals/cel';

/**
 * A published asset serves its resource bytes from its own origin. An `update`
 * that appended a signed `toHash` without hosting the matching bytes would
 * publish a log naming a URL that 404s — the log out-running what anyone can
 * fetch. These pin the invariant: after a did:webvh update the new version is
 * fetchable at exactly the key publishToWeb would have written it to.
 */
const V1 = 'first draft';
const V2 = 'second draft';

const resources = () => [
  {
    id: 'doc.txt',
    type: 'text',
    content: V1,
    contentType: 'text/plain',
    hash: hashResource(new TextEncoder().encode(V1))
  }
];

/**
 * The location publishResources uses:
 * {domain} + {userPath}/resources/{segment} — the CANONICAL multibase
 * multihash segment ("uEi..."), the only form ever written. The 'legacy' form
 * below exists only to assert it is NOT written.
 */
function hostedAt(webvhDid: string, hash: string, form: 'canonical' | 'legacy' = 'canonical'): { domain: string; path: string } {
  const parts = webvhDid.split(':');
  const domain = decodeURIComponent(parts[3]);
  const userPath = parts.slice(4).join('/');
  const segment = form === 'canonical'
    ? resourcePathSegment(hash)
    : encodeBase64UrlMultibase(hexToBytes(hash));
  return {
    domain,
    path: userPath ? `${userPath}/resources/${segment}` : `resources/${segment}`
  };
}

/** Read back whatever is hosted for a resource version, or null. */
function served(storage: MemoryStorageAdapter, webvhDid: string, hash: string, form: 'canonical' | 'legacy' = 'canonical') {
  const { domain, path } = hostedAt(webvhDid, hash, form);
  return storage.getObject(domain, path);
}

function makeSdk(storage: MemoryStorageAdapter, keyStore: MockKeyStore = new MockKeyStore(), config?: Record<string, unknown>) {
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
    keyStore,
    storageAdapter: storage,
    ...config
  } as never);
  return { sdk, keyStore };
}

async function publishedAsset(storage: MemoryStorageAdapter, config?: Record<string, unknown>) {
  const { sdk, keyStore } = makeSdk(storage, new MockKeyStore(), config);
  const asset = await sdk.lifecycle.createAsset(resources() as never);
  const publisher = await sdk.did.createDIDWebVH({ domain: 'example.com', paths: ['pub'] });
  await sdk.lifecycle.publishToWeb(asset, (publisher as { did: string }).did);
  return { sdk, asset, keyStore };
}

describe('addResourceVersion on a published (did:webvh) asset', () => {
  beforeEach(() => MemoryStorageAdapter.clear());

  test('hosts the new version at the same key publishToWeb would have used', async () => {
    const storage = new MemoryStorageAdapter();
    const { asset } = await publishedAsset(storage);
    const webvhDid = asset.bindings!['did:webvh']!;

    // Genesis bytes are hosted by publishToWeb.
    expect(await served(storage, webvhDid, asset.resources[0].hash)).not.toBeNull();

    const v2 = await asset.addResourceVersion('doc.txt', V2, 'text/plain', 'revised');

    const hosted = await served(storage, webvhDid, v2.hash);
    expect(hosted).not.toBeNull();
    expect(new TextDecoder().decode(hosted!.content)).toBe(V2);
    // The signed event names this exact hash — the log and the bytes agree.
    const head = asset.celLog!.events[asset.celLog!.events.length - 1];
    expect(head.type).toBe('update');
    expect((head.data as { toHash: string }).toHash).toBe(v2.hash);
  });

  test('an update writes ONLY the canonical key — the legacy raw-digest key never exists', async () => {
    const storage = new MemoryStorageAdapter();
    const { asset } = await publishedAsset(storage);
    const webvhDid = asset.bindings!['did:webvh']!;

    const v2 = await asset.addResourceVersion('doc.txt', V2, 'text/plain');

    const canonical = await served(storage, webvhDid, v2.hash, 'canonical');
    expect(canonical).not.toBeNull();
    expect(new TextDecoder().decode(canonical!.content)).toBe(V2);
    expect(await served(storage, webvhDid, v2.hash, 'legacy')).toBeNull();
  });

  test('the previous version stays hosted — old URLs keep resolving', async () => {
    const storage = new MemoryStorageAdapter();
    const { asset } = await publishedAsset(storage);
    const webvhDid = asset.bindings!['did:webvh']!;
    const v1Hash = asset.resources[0].hash;

    await asset.addResourceVersion('doc.txt', V2, 'text/plain');

    expect(await served(storage, webvhDid, v1Hash)).not.toBeNull();
  });

  test('stacked revisions each land', async () => {
    const storage = new MemoryStorageAdapter();
    const { asset } = await publishedAsset(storage);
    const webvhDid = asset.bindings!['did:webvh']!;

    const v2 = await asset.addResourceVersion('doc.txt', V2, 'text/plain');
    const v3 = await asset.addResourceVersion('doc.txt', 'third draft', 'text/plain');

    expect(await served(storage, webvhDid, v2.hash)).not.toBeNull();
    expect(await served(storage, webvhDid, v3.hash)).not.toBeNull();
    expect(asset.celLog!.events.filter((e) => e.type === 'update')).toHaveLength(2);
  });

  test('the asset still verifies after a published update', async () => {
    const storage = new MemoryStorageAdapter();
    const { asset } = await publishedAsset(storage);
    await asset.addResourceVersion('doc.txt', V2, 'text/plain');
    expect((await asset.verify()).verified).toBe(true);
  });

  // Abort-before-mutate: hosting runs BEFORE the append, so a hosting failure
  // leaves the log untouched rather than stranding an event whose bytes 404.
  test('an unhostable update is refused with the log untouched', async () => {
    const storage = new MemoryStorageAdapter();
    const { sdk, asset } = await publishedAsset(storage);
    const before = asset.celLog!.events.length;

    // Drop the adapter: nothing can host the new bytes any more.
    (sdk.lifecycle as unknown as { config: Record<string, unknown> }).config.storageAdapter = undefined;

    await expect(asset.addResourceVersion('doc.txt', V2, 'text/plain')).rejects.toThrow(
      /storageAdapter/
    );
    expect(asset.celLog!.events.length).toBe(before);
    // And no phantom version was pushed in memory either.
    expect(asset.resources.filter((r) => r.id === 'doc.txt')).toHaveLength(1);
  });

  // resource:published cannot be announced correctly from the update path: it
  // would run inside the append, before the version reaches asset.resources.
  // resource:version:created is the correctly-ordered signal, so no second,
  // earlier one is emitted.
  test('no resource:published is emitted for an update', async () => {
    const storage = new MemoryStorageAdapter();
    const { asset } = await publishedAsset(storage);
    const published: unknown[] = [];
    asset.on('resource:published', (e) => published.push(e));

    const v2 = await asset.addResourceVersion('doc.txt', V2, 'text/plain');

    expect(published).toHaveLength(0);
    // …and the bytes really were hosted; the event is what's absent, not the write.
    const webvhDid = asset.bindings!['did:webvh']!;
    expect(await served(storage, webvhDid, v2.hash)).not.toBeNull();
  });

  test('resource:version:created lands AFTER the version is in asset.resources', async () => {
    const storage = new MemoryStorageAdapter();
    const { asset } = await publishedAsset(storage);
    let seen: { inResources: boolean; count: number } | null = null;
    asset.on('resource:version:created', (e) => {
      const hash = (e as { resource: { toHash: string } }).resource.toHash;
      seen = {
        inResources: asset.resources.some((r) => r.hash === hash),
        count: asset.resources.filter((r) => r.id === 'doc.txt').length
      };
    });

    await asset.addResourceVersion('doc.txt', V2, 'text/plain');
    await new Promise((r) => setTimeout(r, 10)); // it is queueMicrotask-deferred

    expect(seen).toEqual({ inResources: true, count: 2 });
  });

  test('an unpublished (did:cel) asset needs no hosting and still updates', async () => {
    const storage = new MemoryStorageAdapter();
    const { sdk } = makeSdk(storage);
    const asset = await sdk.lifecycle.createAsset(resources() as never);

    const v2 = await asset.addResourceVersion('doc.txt', V2, 'text/plain');

    expect(v2.version).toBe(2);
    expect(asset.celLog!.events.filter((e) => e.type === 'update')).toHaveLength(1);
  });
});
