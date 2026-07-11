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

  test('rotation preserves the resource manifest in the resolved document', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });

    const doc = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    expect(doc).not.toBeNull();
    const manifestService = doc!.service?.find((s: any) => s.type === 'OriginalsResourceManifest');
    expect(manifestService).toBeDefined();
    expect((manifestService as any).serviceEndpoint.resources[0].hash).toBe(asset.resources[0].hash);
  });

  test('derives btco network from webvhNetwork tier when no explicit network is set', async () => {
    // magby → regtest. With no `network`, the binding is minted did:btco:reg:N;
    // rotation must derive the same network or it bricks with NETWORK_MISMATCH.
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ webvhNetwork: 'magby', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '9a'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;
    expect(btcoDid.startsWith('did:btco:reg:')).toBe(true);

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    const rotation = await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });
    expect(rotation.did).toBe(btcoDid);
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
