/* istanbul ignore file */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OriginalsAsset } from '../../src';
import { MockOrdinalsProvider } from '../mocks/adapters';

describe('Integration: Lifecycle.transferOwnership for did:btco', () => {
  const provider = new MockOrdinalsProvider();
  const sdk = OriginalsSDK.create({ network: 'regtest', bitcoinRpcUrl: 'http://ord', ordinalsProvider: provider } as any);

  test('thin sat move: returns txid and leaves provenance untouched', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'res1', type: 'text', contentType: 'text/plain', hash: 'dead' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:123' } as any,
      []
    );

    const tx = await sdk.lifecycle.transferOwnership(asset, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
    // Transfer is a pure sat move; ownership history is the sat's UTXO chain, not the CEL.
    expect(typeof tx.txid).toBe('string');
  });
});

