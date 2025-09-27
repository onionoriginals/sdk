import { OriginalsSDK } from '../../src';
import { BtcoDidResolver } from '../../src/did/BtcoDidResolver';

describe('DIDManager.resolveDID covers btco method variants', () => {
  test('resolves did:btco:test:* via resolver', async () => {
    const sdk = OriginalsSDK.create({ bitcoinRpcUrl: 'http://x', network: 'mainnet' });
    const spy = jest.spyOn(BtcoDidResolver.prototype as any, 'resolve');
    spy.mockResolvedValueOnce({ didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:test:1' } });
    const res = await sdk.did.resolveDID('did:btco:test:1');
    expect(res?.id).toBe('did:btco:test:1');
    spy.mockRestore();
  });

  test('resolves did:btco:sig:* via resolver', async () => {
    const sdk = OriginalsSDK.create({ bitcoinRpcUrl: 'http://x', network: 'mainnet' });
    const spy = jest.spyOn(BtcoDidResolver.prototype as any, 'resolve');
    spy.mockResolvedValueOnce({ didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:sig:2' } });
    const res = await sdk.did.resolveDID('did:btco:sig:2');
    expect(res?.id).toBe('did:btco:sig:2');
    spy.mockRestore();
  });
});

