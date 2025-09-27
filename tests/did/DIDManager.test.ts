import { OriginalsSDK } from '../../src';
import { DIDDocument, AssetResource } from '../../src/types';

const resources: AssetResource[] = [
  { id: 'r1', type: 'data', contentType: 'application/json', hash: 'cafebabe' }
];

describe('DIDManager', () => {
  const sdk = OriginalsSDK.create();

  test('createDIDPeer returns a valid DID document (expected to fail until implemented)', async () => {
    const didDoc = await sdk.did.createDIDPeer(resources);
    expect(didDoc.id.startsWith('did:peer:')).toBe(true);
    expect(didDoc['@context']).toBeDefined();
  });

  test('migrateToDIDWebVH converts to did:webvh (expected to fail until implemented)', async () => {
    const didDoc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz' };
    const webDoc = await sdk.did.migrateToDIDWebVH(didDoc, 'example.com');
    expect(webDoc.id.startsWith('did:webvh:')).toBe(true);
  });

  test('migrateToDIDBTCO converts to did:btco (expected to fail until implemented)', async () => {
    const didDoc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:example.com:xyz' };
    const btcoDoc = await sdk.did.migrateToDIDBTCO(didDoc, '123');
    expect(btcoDoc.id.startsWith('did:btco:')).toBe(true);
  });

  test('resolveDID resolves documents (expected to fail until implemented)', async () => {
    const doc = await sdk.did.resolveDID('did:peer:abc');
    expect(doc).not.toBeNull();
  });

  test('validateDIDDocument returns true for valid doc (expected to fail until implemented)', () => {
    const doc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz' };
    expect(sdk.did.validateDIDDocument(doc)).toBe(true);
  });
});

/** Inlined from DIDManager.createBtco.part.ts */
import { multikey } from '../../src/crypto/Multikey';

describe('DIDManager.createBtcoDidDocument method', () => {
  test('creates btco DID document via manager wrapper', () => {
    const sdk = OriginalsSDK.create();
    const pub = new Uint8Array(32).fill(1);
    const doc = sdk.did.createBtcoDidDocument('123', 'mainnet', { publicKey: pub, keyType: 'Ed25519' });
    expect(doc.id).toBe('did:btco:123');
    const vm = doc.verificationMethod![0];
    expect(vm.id).toBe('did:btco:123#0');
    const decoded = multikey.decodePublicKey(vm.publicKeyMultibase);
    expect(decoded.type).toBe('Ed25519');
  });
});




/** Inlined from DIDManager.getLayer.throw.part.ts */
import { DIDManager } from '../../src/did/DIDManager';

describe('DIDManager.getLayerFromDID error branch', () => {
  test('throws Unsupported DID method', () => {
    const dm: any = new DIDManager({} as any);
    expect(() => dm["getLayerFromDID"]('did:example:xyz')).toThrow('Unsupported DID method');
  });
});




/** Inlined from DIDManager.private.part.ts */

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





/** Inlined from DIDManager.resolve.catch.part.ts */
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




/** Inlined from DIDManager.resolve.defaults.part.ts */

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




/** Inlined from DIDManager.resolve.methods.part.ts */

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




/** Inlined from DIDManager.validate.false.part.ts */

describe('DIDManager.validateDIDDocument false branch', () => {
  test('returns false when context missing', () => {
    const dm = new DIDManager({} as any);
    const res = dm.validateDIDDocument({ id: 'did:peer:xyz' } as any);
    expect(res).toBe(false);
  });
});
