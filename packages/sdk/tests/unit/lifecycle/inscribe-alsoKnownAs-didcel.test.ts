import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { deriveDidCel } from '../../../src/cel/celDid';

describe('inscribeOnBitcoin — did:cel back-link in alsoKnownAs', () => {
  test('inscribed btco doc back-links the did:cel; enumerable via getAnchoringsForDidCel', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      keyStore: new MockKeyStore(),
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) },
    ]);
    const didCel = deriveDidCel(asset.celLog!);
    expect(didCel.startsWith('did:cel:')).toBe(true);
    expect(asset.id).toBe(didCel);

    await sdk.lifecycle.inscribeOnBitcoin(asset);

    // Round-trip: the anchoring is indexable by the asset's did:cel.
    const anchorings = await provider.getAnchoringsForDidCel!(didCel);
    expect(anchorings.length).toBeGreaterThanOrEqual(1);
    // The anchored sat carries the inscription.
    const btcoDid = asset.bindings!['did:btco']!;
    const sat = btcoDid.replace(/^did:btco:(reg:|sig:)?/, '');
    expect(anchorings.some((a) => a.satoshi === sat)).toBe(true);

    // And the inscribed document literally lists the did:cel first.
    const resolved = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    expect(resolved!.alsoKnownAs?.[0]).toBe(didCel);
  });
});
