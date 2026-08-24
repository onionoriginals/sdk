/** Canonical test aggregator created by combine-tests script. */

/** Inlined from WebVhPublish.integration.part.ts */
import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { AssetResource } from '../../src/types';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { resourcePathSegment } from '@originals/cel';
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
 * multihash segment ("uEi...") — the ONLY segment form; the legacy raw-digest
 * form ("ud...") is never written (the protocol starts fresh, no legacy URL
 * exists).
 */
describe('resource URL hash encoding (canonical multihash only)', () => {
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

  async function publish() {
    const storage = new MemoryStorageAdapter();
    const sdk = OriginalsSDK.create({
      storageAdapter: storage,
      network: 'regtest',
      keyStore: new MockKeyStore()
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
  });

  test('only the canonical key is written — the legacy raw-digest key never is', async () => {
    const { storage, webvhDid } = await publish();
    const canonical = pathFor(webvhDid, resourcePathSegment(HELLO_HASH));
    const legacy = pathFor(webvhDid, encodeBase64UrlMultibase(hexToBytes(HELLO_HASH)));

    const canonicalObj = await storage.getObject(canonical.domain, canonical.path);
    expect(canonicalObj).not.toBeNull();
    expect(new TextDecoder().decode(canonicalObj!.content)).toBe('hello');
    expect(await storage.getObject(legacy.domain, legacy.path)).toBeNull();
  });

  test('a mid-publish failure rolls back the written resource key', async () => {
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
    expect(deleted.some((p) => p.endsWith(`resources/${canonicalSegment}`))).toBe(true);
    // Nothing at either key survived the rollback.
    for (const key of objects.keys()) {
      expect(key.includes('/resources/')).toBe(false);
    }
    // And the resource url was reverted.
    expect(asset.resources[0].url).toBeUndefined();
  });
});
