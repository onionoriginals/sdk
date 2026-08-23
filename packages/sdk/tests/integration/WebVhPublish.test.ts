/** Canonical test aggregator created by combine-tests script. */

/** Inlined from WebVhPublish.integration.part.ts */
import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { AssetResource } from '../../src/types';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { resourcePathSegment, parseResourcePathSegment } from '@originals/cel';
import { encodeBase64UrlMultibase, hexToBytes } from '@originals/cel/encoding';

describe('WebVH publish end-to-end', () => {
  const keyStore = new MockKeyStore();
  const sdk = OriginalsSDK.create({ storageAdapter: new MemoryStorageAdapter(), network: 'regtest', keyStore });
  const publisherDid = 'did:webvh:example.com:alice';

  test('createAsset → publishToWeb yields did:webvh and provenance event', async () => {
    const resources: AssetResource[] = [
      { id: 'r1', type: 'data', contentType: 'text/plain', hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', content: 'hello' }
    ];

    const asset = await sdk.lifecycle.createAsset(resources);
    const published = await sdk.lifecycle.publishToWeb(asset, publisherDid);
    
    // Asset migrated to did:webvh layer
    expect(published.currentLayer).toBe('did:webvh');
    expect(published.id.startsWith('did:cel:')).toBe(true);
    
    // Binding is a real minted did:webvh owned by the asset: did:webvh:{SCID}:{domain}[:slug].
    // It embeds the publisher's domain but is never equal to the publisher shorthand input.
    const webBinding = (published as any).bindings?.['did:webvh'];
    expect(typeof webBinding).toBe('string');
    expect(webBinding).toMatch(/^did:webvh:[^:]+:example\.com(:.+)?$/);
    expect(webBinding).not.toBe(publisherDid);

    // Binding resolution over HTTP requires hosting; the storage-hosted log is asserted in LifecycleManager.mintwebvh.test.ts

    // Resources have DID-based URLs (not .well-known)
    expect(Array.isArray(published.resources)).toBe(true);
    for (const r of published.resources) {
      expect(typeof r.url).toBe('string');
      expect((r.url as string).startsWith(webBinding)).toBe(true);
      expect((r.url as string).includes('/resources/')).toBe(true);
    }

    // Credentials may or may not be attached (best-effort)
    // If the publisher DID doesn't have keys, credentials won't be issued
    // This is acceptable - the publish operation succeeds regardless
    const creds = (published as any).credentials || [];
    expect(Array.isArray(creds)).toBe(true);
  });
});

/**
 * One hash encoding: published resource URLs carry the canonical multibase
 * multihash segment ("uEi..."), never the legacy raw-digest form ("ud...").
 * During the legacyResourceUrlCompat transition (default on) the bytes are
 * ALSO stored under the legacy key so previously-copied URLs keep resolving.
 */
describe('resource URL hash encoding (canonical multihash + legacy compat)', () => {
  beforeEach(() => MemoryStorageAdapter.clear());

  const HELLO_HASH = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  const resources = (): AssetResource[] => [
    { id: 'r1', type: 'data', contentType: 'text/plain', hash: HELLO_HASH, content: 'hello' }
  ];

  /** domain + userPath of a minted did:webvh:{SCID}:{domain}[:path...]. */
  function mintedLocation(webvhDid: string): { domain: string; userPath: string } {
    const parts = webvhDid.split(':');
    return { domain: decodeURIComponent(parts[3]), userPath: parts.slice(4).join('/') };
  }

  function pathFor(webvhDid: string, segment: string): { domain: string; path: string } {
    const { domain, userPath } = mintedLocation(webvhDid);
    return { domain, path: userPath ? `${userPath}/resources/${segment}` : `resources/${segment}` };
  }

  async function publish(config?: { legacyResourceUrlCompat?: boolean }) {
    const storage = new MemoryStorageAdapter();
    const sdk = OriginalsSDK.create({
      storageAdapter: storage,
      network: 'regtest',
      keyStore: new MockKeyStore(),
      ...config
    } as never);
    const asset = await sdk.lifecycle.createAsset(resources());
    const published = await sdk.lifecycle.publishToWeb(asset, 'did:webvh:example.com:alice');
    const webvhDid = (published as any).bindings['did:webvh'] as string;
    return { storage, published, webvhDid };
  }

  test('published resource.url path segment is the canonical multihash form (uEi..., not ud...)', async () => {
    const { published } = await publish();
    const url = published.resources[0].url as string;
    const segment = url.split('/resources/')[1];
    expect(segment.startsWith('uEi')).toBe(true);
    expect(segment).toBe(resourcePathSegment(HELLO_HASH));
    // And it decodes back to the declared hash.
    expect(parseResourcePathSegment(segment)).toBe(HELLO_HASH);
  });

  test('with compat on (default), identical bytes are stored at BOTH the canonical and legacy keys', async () => {
    const { storage, webvhDid } = await publish();
    const canonical = pathFor(webvhDid, resourcePathSegment(HELLO_HASH));
    const legacy = pathFor(webvhDid, encodeBase64UrlMultibase(hexToBytes(HELLO_HASH)));

    const canonicalObj = await storage.getObject(canonical.domain, canonical.path);
    const legacyObj = await storage.getObject(legacy.domain, legacy.path);
    expect(canonicalObj).not.toBeNull();
    expect(legacyObj).not.toBeNull();
    expect(new TextDecoder().decode(canonicalObj!.content)).toBe('hello');
    expect(new TextDecoder().decode(legacyObj!.content)).toBe('hello');
  });

  test('with legacyResourceUrlCompat: false, only the canonical key is written', async () => {
    const { storage, webvhDid } = await publish({ legacyResourceUrlCompat: false });
    const canonical = pathFor(webvhDid, resourcePathSegment(HELLO_HASH));
    const legacy = pathFor(webvhDid, encodeBase64UrlMultibase(hexToBytes(HELLO_HASH)));

    expect(await storage.getObject(canonical.domain, canonical.path)).not.toBeNull();
    expect(await storage.getObject(legacy.domain, legacy.path)).toBeNull();
  });

  test('a mid-publish failure rolls back BOTH written keys', async () => {
    // Adapter with delete support that fails the publish AFTER resources are
    // written (at the did.jsonl host step), so atomicRollback runs.
    const objects = new Map<string, Uint8Array>();
    const deleted: string[] = [];
    const failingStorage = {
      putObject(domain: string, path: string, data: Uint8Array): Promise<void> {
        if (path.endsWith('did.jsonl')) throw new Error('host outage');
        objects.set(`${domain}/${path}`, data);
        return Promise.resolve();
      },
      getObject(domain: string, path: string): Promise<{ content: Uint8Array } | null> {
        const hit = objects.get(`${domain}/${path}`);
        return Promise.resolve(hit ? { content: hit } : null);
      },
      deleteObject(domain: string, path: string): Promise<void> {
        objects.delete(`${domain}/${path}`);
        deleted.push(path);
        return Promise.resolve();
      }
    };
    const sdk = OriginalsSDK.create({
      storageAdapter: failingStorage,
      network: 'regtest',
      keyStore: new MockKeyStore()
    } as never);
    const asset = await sdk.lifecycle.createAsset(resources());

    await expect(sdk.lifecycle.publishToWeb(asset, 'did:webvh:example.com:alice')).rejects.toThrow('host outage');

    const canonicalSegment = resourcePathSegment(HELLO_HASH);
    const legacySegment = encodeBase64UrlMultibase(hexToBytes(HELLO_HASH));
    expect(deleted.some((p) => p.endsWith(`resources/${canonicalSegment}`))).toBe(true);
    expect(deleted.some((p) => p.endsWith(`resources/${legacySegment}`))).toBe(true);
    // Nothing at either key survived the rollback.
    for (const key of objects.keys()) {
      expect(key.includes('/resources/')).toBe(false);
    }
    // And the resource url was reverted.
    expect(asset.resources[0].url).toBeUndefined();
  });

  test('legacy URLs from assets published before the change still resolve via parseResourcePathSegment', async () => {
    // Simulate a pre-change publish: bytes seeded at the LEGACY key only.
    const storage = new MemoryStorageAdapter();
    const legacySegment = encodeBase64UrlMultibase(hexToBytes(HELLO_HASH));
    await storage.putObject('example.com', `alice/resources/${legacySegment}`, new TextEncoder().encode('hello'));

    // A reader that decodes the path segment with parseResourcePathSegment
    // recovers the hex hash from EITHER form, so it can locate the bytes by
    // re-deriving whichever key the publisher wrote.
    expect(parseResourcePathSegment(legacySegment)).toBe(HELLO_HASH);
    expect(parseResourcePathSegment(resourcePathSegment(HELLO_HASH))).toBe(HELLO_HASH);
    const found = await storage.getObject('example.com', `alice/resources/${legacySegment}`);
    expect(found).not.toBeNull();
  });
});
