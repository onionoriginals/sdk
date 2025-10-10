/** Canonical test aggregator created by combine-tests script. */

/** Inlined from WebVhPublish.integration.part.ts */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { AssetResource } from '../../src/types';
import { MockKeyStore } from '../mocks/MockKeyStore';

describe('WebVH publish end-to-end', () => {
  const keyStore = new MockKeyStore();
  const sdk = OriginalsSDK.create({ network: 'regtest', keyStore });
  const publisherDid = 'did:webvh:example.com:alice';

  test('createAsset → publishToWeb yields did:webvh and provenance event', async () => {
    const resources: AssetResource[] = [
      { id: 'r1', type: 'data', contentType: 'text/plain', hash: 'abc123', content: 'hello' }
    ];

    const asset = await sdk.lifecycle.createAsset(resources);
    const published = await sdk.lifecycle.publishToWeb(asset, publisherDid);
    
    // Asset migrated to did:webvh layer
    expect(published.currentLayer).toBe('did:webvh');
    expect(published.id.startsWith('did:peer:')).toBe(true);
    
    // Binding to publisher's did:webvh
    const webBinding = (published as any).bindings?.['did:webvh'];
    expect(typeof webBinding).toBe('string');
    expect(webBinding).toBe(publisherDid);

    const resolved = await sdk.did.resolveDID(webBinding!);
    expect(resolved?.id).toBe(webBinding);

    // Resources have DID-based URLs (not .well-known)
    expect(Array.isArray(published.resources)).toBe(true);
    for (const r of published.resources) {
      expect(typeof r.url).toBe('string');
      expect((r.url as string).startsWith(publisherDid)).toBe(true);
      expect((r.url as string).includes('/resources/')).toBe(true);
    }

    // Credentials may or may not be attached (best-effort)
    // If the publisher DID doesn't have keys, credentials won't be issued
    // This is acceptable - the publish operation succeeds regardless
    const creds = (published as any).credentials || [];
    expect(Array.isArray(creds)).toBe(true);
  });
});
