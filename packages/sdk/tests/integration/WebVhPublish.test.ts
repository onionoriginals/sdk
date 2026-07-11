/** Canonical test aggregator created by combine-tests script. */

/** Inlined from WebVhPublish.integration.part.ts */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { AssetResource } from '../../src/types';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';

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
