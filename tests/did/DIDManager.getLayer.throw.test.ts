import { DIDManager } from '../../src/did/DIDManager';

describe('DIDManager.getLayerFromDID error branch', () => {
  test('throws Unsupported DID method', () => {
    const dm: any = new DIDManager({} as any);
    expect(() => dm["getLayerFromDID"]('did:example:xyz')).toThrow('Unsupported DID method');
  });
});

