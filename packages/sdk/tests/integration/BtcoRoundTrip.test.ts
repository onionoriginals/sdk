import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';

describe('did:btco round-trip (#375)', () => {
  test('lifecycle-inscribed asset resolves through the SDK resolver', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'ES256K',
      ordinalsProvider: new OrdMockProvider()
    });
    const asset = await sdk.lifecycle.createAsset([
      // Declared-hash-only resource: inline content would be hash-checked by
      // createAsset (#347) and 'ab'.repeat(32) is not the hash of any short string.
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'ab'.repeat(32) }
    ]);
    const peerDid = asset.id;

    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings?.['did:btco'];
    expect(btcoDid).toMatch(/^did:btco:reg:\d+$/);

    // The SDK's own resolver must accept its own inscription.
    const doc = await sdk.did.resolveDID(btcoDid!);
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(btcoDid!);
    expect(doc!.alsoKnownAs).toContain(peerDid);
    const svc = (doc!.service || []).find(s => s.type === 'OriginalsResourceManifest');
    expect(svc).toBeDefined();
    const endpoint = svc!.serviceEndpoint as { resources: Array<{ id: string; hash: string }> };
    expect(endpoint.resources[0].hash).toBe('ab'.repeat(32));
  });
});
