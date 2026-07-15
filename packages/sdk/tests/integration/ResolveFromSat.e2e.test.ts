/**
 * Bare-sat resolution (#407 phase 2). A resolver with ONLY the satoshi + an
 * ordinals provider reconstructs an asset's provenance (from inscription
 * metadata) AND its current media (from inscription content), verified, with NO
 * envelope and NO host. Provenance is recoverable from Bitcoin alone.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { hashResource } from '../../src/utils/validation';

const contentHash = (s: string) => hashResource(Buffer.from(s, 'utf8'));

function makeSDK() {
  const ordinalsProvider = new OrdMockProvider();
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider,
    storageAdapter: new MemoryStorageAdapter(),
    keyStore: new MockKeyStore()
  });
  return { sdk, ordinalsProvider };
}

describe('resolveAssetFromSat — bare-sat chain recovery (#407 phase 2)', () => {
  test('create → addResourceVersion → publish → inscribe → resolve reconstructs + verifies from the sat alone', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('v1-bytes'), content: 'v1-bytes' }
    ]);
    // Update the media so the current head is v2 — the resolver must recover v2.
    await asset.addResourceVersion('art', 'v2-bytes', 'image/png', 'update to v2');
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    const sat = asset.bindings!['did:btco'].split(':').pop()!;

    // Fresh SDK: only the sat + provider, no envelope, no host.
    const fresh = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider });
    const { asset: recovered, verification, warnings } = await fresh.lifecycle.resolveAssetFromSat(sat);

    expect(recovered.id).toBe(asset.id);
    expect(recovered.currentLayer).toBe('did:btco');
    expect(verification?.verified).toBe(true);
    // The recovered current media is v2 (the most-recent resource).
    const head = recovered.resources.find(r => r.hash === contentHash('v2-bytes'));
    expect(head?.content).toBe('v2-bytes');
    // No spurious verification warnings about the head blob.
    expect(warnings.some(w => /has no backing blob/.test(w))).toBe(false);
  });

  test('single-resource asset (no updates) round-trips the genesis media', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'doc', type: 'data', contentType: 'application/json', hash: contentHash('{"k":1}'), content: '{"k":1}' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const sat = asset.bindings!['did:btco'].split(':').pop()!;

    const { asset: recovered, verification } = await sdk.lifecycle.resolveAssetFromSat(sat);
    expect(verification?.verified).toBe(true);
    expect(recovered.resources.find(r => r.hash === contentHash('{"k":1}'))?.content).toBe('{"k":1}');
  });

  test('tampered on-chain media content → resolution fails closed', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('real-media'), content: 'real-media' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const sat = asset.bindings!['did:btco'].split(':').pop()!;

    // Tamper: rewrite the anchoring inscription's content to bytes that do NOT
    // hash to the head resource.
    const list = await ordinalsProvider.getInscriptionsBySatoshi(sat);
    const insc = await ordinalsProvider.getInscriptionById(list[list.length - 1].inscriptionId);
    (ordinalsProvider as any)['state'].inscriptionsById.get(insc!.inscriptionId).content = Buffer.from('FORGED-MEDIA');

    await expect(sdk.lifecycle.resolveAssetFromSat(sat)).rejects.toThrow();
  });

  test('tampered embedded celLog (metadata) → resolution fails closed', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('media'), content: 'media' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const sat = asset.bindings!['did:btco'].split(':').pop()!;

    const list = await ordinalsProvider.getInscriptionsBySatoshi(sat);
    const rec = (ordinalsProvider as any)['state'].inscriptionsById.get(list[list.length - 1].inscriptionId);
    // Flip a byte in a signed genesis field of the embedded log.
    rec.metadata.celLog.events[0].data.name = 'TAMPERED';

    await expect(sdk.lifecycle.resolveAssetFromSat(sat)).rejects.toThrow();
  });

  test('no anchoring inscription on the sat → fails closed', async () => {
    const { sdk } = makeSDK();
    await expect(sdk.lifecycle.resolveAssetFromSat('999999999')).rejects.toThrow(/CHAIN_ASSET_NOT_FOUND|Cannot resolve/);
  });
});
