import { OriginalsSDK } from '../../src';

describe('LifecycleManager provenance fallback', () => {
  test('inscribeOnBitcoin initializes provenance when missing', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const asset = await sdk.lifecycle.createAsset([{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'aa' }]);
    // ensure provenance exists but is empty (migrations/transfers arrays present)
    (asset as any).provenance = { createdAt: new Date().toISOString(), creator: asset.id, migrations: [], transfers: [] };
    const updated = await sdk.lifecycle.inscribeOnBitcoin(asset);
    expect((updated as any).provenance.txid).toBeDefined();
    expect((updated as any).provenance.feeRate).toBeGreaterThan(0);
  });
});