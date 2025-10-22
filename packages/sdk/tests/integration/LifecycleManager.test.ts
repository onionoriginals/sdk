/** Canonical test aggregator created by combine-tests script. */

/** Inlined from LifecycleManager.btco.integration.part.ts */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { MockOrdinalsProvider } from '../mocks/adapters';

describe('Integration: Lifecycle inscribe updates provenance and btco layer', () => {
  test('provenance updated and layer becomes did:btco', async () => {
    const provider = new MockOrdinalsProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', bitcoinRpcUrl: 'http://ord', ordinalsProvider: provider } as any);
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
