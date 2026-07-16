/** Canonical test aggregator created by combine-tests script. */

/** Inlined from LifecycleManager.btco.integration.part.ts */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OrdMockProvider } from '../../src';
import { MockOrdinalsProvider } from '../mocks/adapters';
import { MockKeyStore } from '../mocks/MockKeyStore';

describe('Integration: Lifecycle inscribe updates provenance and btco layer', () => {
  test('provenance updated and layer becomes did:btco', async () => {
    const provider = new MockOrdinalsProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', bitcoinRpcUrl: 'http://ord', ordinalsProvider: provider } as any);
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res1', type: 'text', contentType: 'text/plain', hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' }
    ]);
    const updated = await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    expect(updated.currentLayer).toBe('did:btco');
    const prov = (updated as any).getProvenance();
    const latest = prov.migrations[prov.migrations.length - 1];
    expect(latest.transactionId).toEqual(expect.any(String));
  });

  test('inscribeOnBitcoin signs the anchoring sat into the migrate event (data.to)', async () => {
    const ordinalsProvider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      keyStore: new MockKeyStore(),
    } as any);

    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) },
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const btcoBinding = asset.bindings!['did:btco']!;
    expect(btcoBinding).toMatch(/^did:btco:reg:\d+$/);

    const migrate = asset.celLog!.events.find(
      (e) => e.type === 'migrate' && (e.data as any)?.layer === 'btco'
    );
    expect(migrate).toBeDefined();
    const data = migrate!.data as any;
    // The signed body now carries the resolvable, network-scoped anchor.
    expect(data.to).toBe(btcoBinding);
    // The bitcoin witness proof carries the SAME sat the migrate signed.
    const witness = (migrate!.proof as any[]).find(
      (p) => p?.cryptosuite === 'bitcoin-ordinals-2024'
    );
    expect(witness).toBeDefined();
    const signedSat = data.to.split(':').pop();
    expect(witness.satoshi).toBe(signedSat);
  });
});
