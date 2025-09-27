import { OriginalsSDK } from '../../src';
import { BtcoDidResolver } from '../../src/did/BtcoDidResolver';

describe('DIDManager.resolveDID catch path', () => {
  test('returns null when resolver throws', async () => {
    const sdk = OriginalsSDK.create({ bitcoinRpcUrl: 'http://localhost:3000', network: 'mainnet' });
    const spy = jest.spyOn(BtcoDidResolver.prototype as any, 'resolve');
    spy.mockImplementationOnce(async () => { throw new Error('resolver failed'); });
    const res = await sdk.did.resolveDID('did:btco:123');
    expect(res).toBeNull();
    spy.mockRestore();
  });
});

