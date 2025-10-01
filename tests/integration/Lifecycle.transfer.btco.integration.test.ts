/* istanbul ignore file */
declare const describe: any, test: any, expect: any;
import { OriginalsSDK, OriginalsAsset } from '../../src';
import { MockOrdinalsProvider } from '../mocks/adapters';

describe('Integration: Lifecycle.transferOwnership for did:btco', () => {
  const provider = new MockOrdinalsProvider();
  const sdk = OriginalsSDK.create({ network: 'regtest', bitcoinRpcUrl: 'http://ord', ordinalsProvider: provider } as any);

  test('returns txid and records provenance transfer', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'res1', type: 'text', contentType: 'text/plain', hash: 'dead' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:123' } as any,
      []
    );

    const tx = await sdk.lifecycle.transferOwnership(asset, 'bcrt1qrecipient');
    expect(typeof tx.txid).toBe('string');
    const prov = asset.getProvenance();
    expect(prov.transfers.length).toBe(1);
    expect(prov.transfers[0].to).toBe('bcrt1qrecipient');
    expect(prov.transfers[0].transactionId).toBe(tx.txid);
  });
});

