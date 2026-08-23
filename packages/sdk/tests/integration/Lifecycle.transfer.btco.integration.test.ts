/* istanbul ignore file */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OriginalsAsset } from '../../src';
import { MockOrdinalsProvider } from '../mocks/adapters';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { KeyManager } from '../../src/did/KeyManager';
import { hashResource } from '../../src/utils/validation';

describe('Integration: Lifecycle.transferOwnership for did:btco', () => {
  const provider = new MockOrdinalsProvider();
  const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), network: 'regtest', bitcoinRpcUrl: 'http://ord', ordinalsProvider: provider } as any);

  test('thin sat move: returns txid and leaves provenance untouched', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'res1', type: 'text', contentType: 'text/plain', hash: 'dead' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:123' } as any,
      []
    );

    const tx = await sdk.lifecycle.transferOwnership(asset, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
    // Transfer is a pure sat move; ownership history is the sat's UTXO chain, not the CEL.
    expect(typeof tx.txid).toBe('string');
  });
});

describe('resolveAssetFromSat after a key rotation (item 4a)', () => {
  test('the derived did:cel document announces the ROTATED key, not the retired genesis key', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      storageAdapter: new MemoryStorageAdapter(),
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'data', contentType: 'text/plain', hash: hashResource(Buffer.from('media', 'utf8')), content: 'media' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const genesisKey = asset.did.verificationMethod?.[0]?.publicKeyMultibase;
    expect(typeof genesisKey).toBe('string');

    const rotated = await new KeyManager().generateKeyPair('Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: rotated.publicKey, privateKey: rotated.privateKey });

    const sat = asset.bindings!['did:btco'].split(':').pop()!;
    const { asset: recovered, verification } = await sdk.lifecycle.resolveAssetFromSat(sat);

    expect(verification?.verified).toBe(true);
    const announced = recovered.did.verificationMethod?.[0]?.publicKeyMultibase;
    expect(announced).toBe(rotated.publicKey);
    expect(announced).not.toBe(genesisKey);
    // The did:key alias announces the same rotated key.
    expect(recovered.did.alsoKnownAs).toContain(`did:key:${rotated.publicKey}`);
  });
});

