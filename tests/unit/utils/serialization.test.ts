import { serializeDIDDocument, deserializeDIDDocument, serializeCredential, deserializeCredential, canonicalizeDocument } from '../../../src/utils/serialization';

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

  test('canonicalizeDocument normalizes nested structures deterministically', async () => {
    const context = {
      '@version': 1.1,
      id: '@id',
      type: '@type',
      name: 'https://schema.org/name',
      details: {
        '@id': 'https://example.org/details',
        '@context': {
          '@version': 1.1,
          count: 'https://example.org/count',
          tags: {
            '@id': 'https://example.org/tags',
            '@container': '@set'
          }
        }
      }
    };

    const docA = {
      '@context': context,
      id: 'urn:example:1',
      type: ['ExampleCredential'],
      name: 'Sample',
      details: {
        count: 2,
        tags: ['b', 'a']
      }
    };

    const docB = {
      name: 'Sample',
      details: {
        tags: ['a', 'b'],
        count: 2
      },
      type: ['ExampleCredential'],
      id: 'urn:example:1',
      '@context': context
    };

    const canonA = await canonicalizeDocument(docA);
    const canonB = await canonicalizeDocument(docB);
    expect(canonA).toEqual(canonB);
  });

  test('deserializeDIDDocument throws on invalid JSON', () => {
    expect(() => deserializeDIDDocument('{invalid')).toThrow('Invalid DID Document JSON');
  });

  test('deserializeCredential throws on invalid JSON', () => {
    expect(() => deserializeCredential('{invalid')).toThrow('Invalid Verifiable Credential JSON');
  });
});


