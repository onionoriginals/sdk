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
import './DIDManager.createBtco.part';
import './DIDManager.getLayer.throw.part';
import './DIDManager.private.part';
import './DIDManager.resolve.catch.part';
import './DIDManager.resolve.defaults.part';
import './DIDManager.resolve.methods.part';
import './DIDManager.validate.false.part';
