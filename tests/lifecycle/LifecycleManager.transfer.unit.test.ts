/* istanbul ignore file */
declare const describe: any, test: any, expect: any;
import { OriginalsSDK, OriginalsAsset } from '../../src';
import { MockOrdinalsProvider } from '../mocks/adapters';

describe('LifecycleManager.transferOwnership unit edge cases', () => {
  const provider = new MockOrdinalsProvider();
  const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);

  test('throws if not on btco layer', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:domain:1' } as any,
      []
    );
    await expect(sdk.lifecycle.transferOwnership(asset as any, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).rejects.toThrow('Asset must be inscribed on Bitcoin before transfer');
  });

  test('succeeds and updates provenance when on btco', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:42' } as any,
      []
    );
    const tx = await sdk.lifecycle.transferOwnership(asset, 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7');
    expect(typeof tx.txid).toBe('string');
    expect(asset.getProvenance().transfers.length).toBe(1);
  });
});

