import { DIDManager } from '../../src/did/DIDManager';
import { OriginalsSDK } from '../../src';

describe('DIDManager private getLayerFromDID', () => {
  const sdk = OriginalsSDK.create();
  const dm: any = sdk.did as any;

  test('returns correct layer for each DID method (expected to pass)', () => {
    expect(dm["getLayerFromDID"]('did:peer:abc')).toBe('did:peer');
    expect(dm["getLayerFromDID"]('did:webvh:example.com:abc')).toBe('did:webvh');
    expect(dm["getLayerFromDID"]('did:btco:123')).toBe('did:btco');
  });

  test('throws on unsupported method (expected to pass)', () => {
    expect(() => dm["getLayerFromDID"]('did:web:example.com')).toThrow('Unsupported DID method');
  });
});


