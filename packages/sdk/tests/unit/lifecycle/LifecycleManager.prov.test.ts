import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MockOrdinalsProvider } from '../../mocks/adapters';

describe('LifecycleManager provenance fallback', () => {
  test('inscribeOnBitcoin initializes provenance when missing', async () => {
    const provider = new MockOrdinalsProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const asset = await sdk.lifecycle.createAsset([{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' }]);
    // ensure provenance exists but is empty (migrations/transfers arrays present)
    (asset as any).provenance = { createdAt: new Date().toISOString(), creator: asset.id, migrations: [], transfers: [] };
    const updated = await sdk.lifecycle.inscribeOnBitcoin(asset);
    const prov = (updated as any).getProvenance();
    const latest = prov.migrations[prov.migrations.length - 1];
    expect(latest.transactionId).toBeDefined();
    expect(latest.feeRate as number).toBeGreaterThan(0);
  });
});