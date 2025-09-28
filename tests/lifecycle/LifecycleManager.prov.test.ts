import { OriginalsSDK } from '../../src';

describe('LifecycleManager provenance fallback', () => {
  test('inscribeOnBitcoin initializes provenance when missing', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const asset = await sdk.lifecycle.createAsset([{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'aa' }]);
    // ensure provenance exists but is empty (migrations/transfers arrays present)
    (asset as any).provenance = { createdAt: new Date().toISOString(), creator: asset.id, migrations: [], transfers: [] };
    const updated = await sdk.lifecycle.inscribeOnBitcoin(asset);
    const prov = (updated as any).getProvenance();
    const latest = prov.migrations[prov.migrations.length - 1];
    expect(latest.transactionId).toBeDefined();
    expect(latest.feeRate as number).toBeGreaterThan(0);
  });
});