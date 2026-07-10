import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { multikey } from '../../../src/crypto/Multikey';

describe('rotateBtcoKeys (#366 rotation-first)', () => {
  test('reinscribes same-id document with the new key; resolver serves it', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;

    // New owner's key: 32 arbitrary bytes — multikey only encodes/decodes bytes,
    // it does not validate the Ed25519 point, so a fixed pattern is fine here.
    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');

    const rotation = await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });
    expect(rotation.did).toBe(btcoDid);

    const doc = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(btcoDid);
    expect(doc!.verificationMethod?.[0]?.publicKeyMultibase).toBe(newKey);
  });

  test('rejects when asset is not on btco layer', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: new OrdMockProvider() });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '78'.repeat(32) }
    ]);
    await expect(
      sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: 'z6Mkfake' })
    ).rejects.toThrow(/btco/i);
  });
});
