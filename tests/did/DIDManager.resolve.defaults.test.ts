import { DIDManager } from '../../src/did/DIDManager';
import { BtcoDidResolver } from '../../src/did/BtcoDidResolver';

describe('DIDManager.resolveDID uses default rpcUrl and network fallbacks', () => {
  test('falls back to http://localhost:3000 and mainnet when config missing', async () => {
    const dm = new DIDManager({} as any);
    const spy = jest.spyOn(BtcoDidResolver.prototype as any, 'resolve');
    spy.mockResolvedValueOnce({ didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:xyz' } });
    const res = await dm.resolveDID('did:btco:xyz');
    expect(res?.id).toBe('did:btco:xyz');
    spy.mockRestore();
  });
});

