/* istanbul ignore file */
declare const describe: any, test: any, expect: any;
import { OriginalsSDK, OriginalsAsset } from '../../src';

describe('LifecycleManager.transferOwnership unit edge cases', () => {
  const sdk = OriginalsSDK.create({ network: 'regtest' });

  test('throws if not on btco layer', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:domain:1' } as any,
      []
    );
    await expect(sdk.lifecycle.transferOwnership(asset as any, 'bcrt1qxxx')).rejects.toThrow('Asset must be inscribed on Bitcoin before transfer');
  });

  test('succeeds and updates provenance when on btco', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:42' } as any,
      []
    );
    const tx = await sdk.lifecycle.transferOwnership(asset, 'bcrt1qnew');
    expect(typeof tx.txid).toBe('string');
    expect(asset.getProvenance().transfers.length).toBe(1);
  });
});

