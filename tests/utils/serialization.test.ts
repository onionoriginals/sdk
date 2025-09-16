import { serializeDIDDocument, deserializeDIDDocument, serializeCredential, deserializeCredential, canonicalizeDocument } from '../../src/utils/serialization';

describe('serialization utils', () => {
  test('serialize/deserialize DID document roundtrip', () => {
    const doc: any = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:abc' };
    const ser = serializeDIDDocument(doc);
    const round = deserializeDIDDocument(ser);
    expect(round).toEqual(doc);
  });

  test('serialize/deserialize VC roundtrip', () => {
    const vc: any = { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 'did:peer:abc', issuanceDate: new Date().toISOString(), credentialSubject: { id: 'did:peer:abc' } };
    const ser = serializeCredential(vc);
    const round = deserializeCredential(ser);
    expect(round).toEqual(vc);
  });

  test('canonicalizeDocument sorts keys', () => {
    const obj: any = { b: 2, a: 1, c: 3 };
    const canon = canonicalizeDocument(obj);
    // In our simplified implementation, JSON.stringify with sorted keys should place a,b,c in order
    expect(canon.indexOf('a')).toBeLessThan(canon.indexOf('b'));
    expect(canon.indexOf('b')).toBeLessThan(canon.indexOf('c'));
  });

  test('deserializeDIDDocument throws on invalid JSON', () => {
    expect(() => deserializeDIDDocument('{invalid')).toThrow('Invalid DID Document JSON');
  });

  test('deserializeCredential throws on invalid JSON', () => {
    expect(() => deserializeCredential('{invalid')).toThrow('Invalid Verifiable Credential JSON');
  });
});


