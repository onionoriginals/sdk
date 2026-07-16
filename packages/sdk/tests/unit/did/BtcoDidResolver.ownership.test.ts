import { describe, test, expect } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

describe('sat ownership (#366)', () => {
  test('OrdMockProvider tracks owner across transfers', async () => {
    const provider = new OrdMockProvider();
    const insc = await provider.createInscription({ data: Buffer.from('x'), contentType: 'text/plain' });
    const before = await provider.getSatOwnership!(insc.satoshi!);
    expect(before).not.toBeNull();
    await provider.transferInscription(insc.inscriptionId, 'bcrt1qnewowner');
    const after = await provider.getSatOwnership!(insc.satoshi!);
    expect(after!.address).toBe('bcrt1qnewowner');
    expect(after!.outpoint).toMatch(/^[a-z0-9-]+:\d+$/);
  });

  test('resolution carries ownership metadata after inscription', async () => {
    const { OriginalsSDK } = await import('../../../src');
    const { OrdinalsProviderResolverAdapter } = await import('../../../src/did/providers/OrdinalsProviderResolverAdapter');
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'ES256K', ordinalsProvider: provider });
    // Inline content must hash-match its declared hash (#347).
    const hash = bytesToHex(sha256(new TextEncoder().encode('y')));
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash, content: 'y' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    // Mirror DIDManager.resolveDID: adapt the configured provider and pin
    // content retrieval through the adapter's fetchContent.
    const adapter = new OrdinalsProviderResolverAdapter(provider);
    const { BtcoDidResolver } = await import('../../../src/did/BtcoDidResolver');
    const resolver = new BtcoDidResolver({ provider: adapter, fetchFn: adapter.fetchContent });
    const res = await resolver.resolve(asset.bindings!['did:btco']!);
    expect((res.didDocumentMetadata as { ownership?: { address: string } }).ownership?.address).toBe('bcrt1qmockowner');
  });
});
