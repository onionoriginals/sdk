/** Canonical test aggregator created by combine-tests script. */

/** Inlined from LifecycleManager.btco.integration.part.ts */
import { OriginalsSDK } from '../../src';

// Ensure Jest types are available
declare const expect: any;

describe('Integration: Lifecycle inscribe updates provenance and btco layer', () => {
  test('provenance updated and layer becomes did:btco', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', bitcoinRpcUrl: 'http://ord' });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res1', type: 'text', contentType: 'text/plain', hash: 'deadbeef' }
    ]);
    const updated = await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    expect(updated.currentLayer).toBe('did:btco');
    const prov = (updated as any).getProvenance();
    const latest = prov.migrations[prov.migrations.length - 1];
    expect(latest.transactionId).toEqual(expect.any(String));
  });
});
