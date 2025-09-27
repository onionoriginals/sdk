import { OriginalsSDK } from '../../src';

describe('LifecycleManager.inscribeOnBitcoin without explicit feeRate', () => {
  test('uses provider.estimateFee when feeRate not provided', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', bitcoinRpcUrl: 'http://ord' });
    const asset = await sdk.lifecycle.createAsset([{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'aa' }]);
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset);
    expect(result.currentLayer).toBe('did:btco');
    expect((result as any).provenance.feeRate).toBeGreaterThan(0);
  });
});

