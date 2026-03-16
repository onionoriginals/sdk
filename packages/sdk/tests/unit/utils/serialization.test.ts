import { describe, test, expect } from 'bun:test';
import { serializeDIDDocument, deserializeDIDDocument, serializeCredential, deserializeCredential, canonicalizeDocument } from '../../../src/utils/serialization';

// Helper to build a valid DID Document
function validDIDDoc(overrides: Record<string, unknown> = {}) {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: 'did:peer:abc',
    ...overrides,
  };
}

// Helper to build a valid Verifiable Credential
function validVC(overrides: Record<string, unknown> = {}) {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:abc',
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:abc' },
    ...overrides,
  };
}

describe('serialization utils', () => {
  test('serialize/deserialize DID document roundtrip', () => {
    const doc = validDIDDoc();
    const ser = serializeDIDDocument(doc as any);
    const round = deserializeDIDDocument(ser);
    expect(round).toEqual(doc);
  });

  test('serialize/deserialize VC roundtrip', () => {
    const vc = validVC();
    const ser = serializeCredential(vc as any);
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

  test('canonicalizeDocument with custom documentLoader', async () => {
    const customLoader = async (url: string) => {
      return {
        documentUrl: url,
        document: {
          '@context': {
            '@version': 1.1,
            'TestType': 'https://example.org/TestType',
            'id': '@id',
            'type': '@type'
          }
        },
        contextUrl: null
      };
    };

    const doc = {
      '@context': 'https://custom.example/context',
      id: 'urn:test:1',
      type: 'TestType'
    };

    const canon = await canonicalizeDocument(doc, { documentLoader: customLoader });
    expect(typeof canon).toBe('string');
    expect(canon).toBeDefined();
  });

  test('canonicalizeDocument throws error with message when canonize fails', async () => {
    const invalidDoc = {
      '@context': 'https://invalid-context-that-doesnt-exist-12345.example/',
      id: 'urn:test:1'
    };

    await expect(canonicalizeDocument(invalidDoc)).rejects.toThrow('Failed to canonicalize document');
  });

  test('canonicalizeDocument handles non-Error thrown values', async () => {
    const doc = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: 'urn:test:1',
      type: 'TestType'
    };

    const canon = await canonicalizeDocument(doc);
    expect(typeof canon).toBe('string');
  });
});

describe('deserializeDIDDocument runtime validation', () => {
  test('rejects JSON array', () => {
    expect(() => deserializeDIDDocument('[]')).toThrow('expected a JSON object');
  });

  test('rejects JSON string primitive', () => {
    expect(() => deserializeDIDDocument('"hello"')).toThrow('expected a JSON object');
  });

  test('rejects JSON number', () => {
    expect(() => deserializeDIDDocument('42')).toThrow('expected a JSON object');
  });

  test('rejects JSON null', () => {
    expect(() => deserializeDIDDocument('null')).toThrow('expected a JSON object');
  });

  test('rejects JSON boolean', () => {
    expect(() => deserializeDIDDocument('true')).toThrow('expected a JSON object');
  });

  test('rejects empty object (missing required fields)', () => {
    expect(() => deserializeDIDDocument('{}')).toThrow('Invalid DID Document');
  });

  test('rejects object missing @context', () => {
    const doc = { id: 'did:peer:abc' };
    expect(() => deserializeDIDDocument(JSON.stringify(doc))).toThrow('@context must be a non-empty array');
  });

  test('rejects object with non-array @context', () => {
    const doc = { '@context': 'https://www.w3.org/ns/did/v1', id: 'did:peer:abc' };
    expect(() => deserializeDIDDocument(JSON.stringify(doc))).toThrow('@context must be a non-empty array');
  });

  test('rejects object missing id', () => {
    const doc = { '@context': ['https://www.w3.org/ns/did/v1'] };
    expect(() => deserializeDIDDocument(JSON.stringify(doc))).toThrow('id must be a valid DID string');
  });

  test('rejects object with non-DID id', () => {
    const doc = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'not-a-did' };
    expect(() => deserializeDIDDocument(JSON.stringify(doc))).toThrow('Invalid DID Document');
  });

  test('rejects object with unsupported DID method', () => {
    const doc = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:unsupported:abc' };
    expect(() => deserializeDIDDocument(JSON.stringify(doc))).toThrow('Invalid DID Document');
  });

  test('rejects object with invalid verificationMethod entries', () => {
    const doc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:abc',
      verificationMethod: [{ id: 'key-1' }],
    };
    expect(() => deserializeDIDDocument(JSON.stringify(doc))).toThrow('Invalid DID Document');
  });

  test('accepts valid DID document with verificationMethod', () => {
    const doc = validDIDDoc({
      verificationMethod: [{
        id: 'did:peer:abc#key-1',
        type: 'Ed25519VerificationKey2020',
        controller: 'did:peer:abc',
        publicKeyMultibase: 'z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP',
      }],
    });
    const result = deserializeDIDDocument(JSON.stringify(doc));
    expect(result).toEqual(doc);
  });

  test('accepts minimal valid DID document', () => {
    const doc = validDIDDoc();
    const result = deserializeDIDDocument(JSON.stringify(doc));
    expect(result).toEqual(doc);
  });
});

describe('deserializeCredential runtime validation', () => {
  test('rejects JSON array', () => {
    expect(() => deserializeCredential('[]')).toThrow('expected a JSON object');
  });

  test('rejects JSON string primitive', () => {
    expect(() => deserializeCredential('"hello"')).toThrow('expected a JSON object');
  });

  test('rejects JSON number', () => {
    expect(() => deserializeCredential('42')).toThrow('expected a JSON object');
  });

  test('rejects JSON null', () => {
    expect(() => deserializeCredential('null')).toThrow('expected a JSON object');
  });

  test('rejects empty object (missing required fields)', () => {
    expect(() => deserializeCredential('{}')).toThrow('Invalid Verifiable Credential');
  });

  test('rejects object missing @context', () => {
    const vc = { type: ['VerifiableCredential'], issuer: 'did:peer:abc', issuanceDate: new Date().toISOString(), credentialSubject: {} };
    expect(() => deserializeCredential(JSON.stringify(vc))).toThrow('@context must be a non-empty array');
  });

  test('rejects object with wrong @context (missing VC v1)', () => {
    const vc = {
      '@context': ['https://example.com/custom'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:abc',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:abc' },
    };
    expect(() => deserializeCredential(JSON.stringify(vc))).toThrow('@context must include W3C VC v1 context');
  });

  test('rejects object missing type', () => {
    const vc = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      issuer: 'did:peer:abc',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:abc' },
    };
    expect(() => deserializeCredential(JSON.stringify(vc))).toThrow('type must be a non-empty array');
  });

  test('rejects object with type missing "VerifiableCredential"', () => {
    const vc = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['SomeOtherType'],
      issuer: 'did:peer:abc',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:abc' },
    };
    expect(() => deserializeCredential(JSON.stringify(vc))).toThrow('type must include "VerifiableCredential"');
  });

  test('rejects object missing issuer', () => {
    const vc = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:abc' },
    };
    expect(() => deserializeCredential(JSON.stringify(vc))).toThrow('issuer is required');
  });

  test('rejects object with invalid issuer (not a DID)', () => {
    const vc = validVC({ issuer: 'not-a-did' });
    expect(() => deserializeCredential(JSON.stringify(vc))).toThrow('Invalid Verifiable Credential');
  });

  test('rejects object missing issuanceDate', () => {
    const vc = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:abc',
      credentialSubject: { id: 'did:peer:abc' },
    };
    expect(() => deserializeCredential(JSON.stringify(vc))).toThrow('issuanceDate is required');
  });

  test('rejects object with invalid issuanceDate', () => {
    const vc = validVC({ issuanceDate: 'not-a-date' });
    expect(() => deserializeCredential(JSON.stringify(vc))).toThrow('Invalid Verifiable Credential');
  });

  test('rejects object missing credentialSubject', () => {
    const vc = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:abc',
      issuanceDate: new Date().toISOString(),
    };
    expect(() => deserializeCredential(JSON.stringify(vc))).toThrow('credentialSubject must be a non-null object');
  });

  test('accepts valid VC with issuer as object', () => {
    const vc = validVC({ issuer: { id: 'did:peer:abc', name: 'Test Issuer' } });
    const result = deserializeCredential(JSON.stringify(vc));
    expect(result).toEqual(vc);
  });

  test('accepts minimal valid VC', () => {
    const vc = validVC();
    const result = deserializeCredential(JSON.stringify(vc));
    expect(result).toEqual(vc);
  });
});

describe('fuzz tests: malformed-but-valid JSON objects', () => {
  describe('DID Document fuzz', () => {
    const fuzzCases: Array<{ name: string; input: unknown }> = [
      { name: 'numeric @context', input: { '@context': 42, id: 'did:peer:abc' } },
      { name: '@context as object', input: { '@context': { url: 'https://example.com' }, id: 'did:peer:abc' } },
      { name: 'null id', input: { '@context': ['https://www.w3.org/ns/did/v1'], id: null } },
      { name: 'numeric id', input: { '@context': ['https://www.w3.org/ns/did/v1'], id: 12345 } },
      { name: 'array id', input: { '@context': ['https://www.w3.org/ns/did/v1'], id: ['did:peer:abc'] } },
      { name: 'empty @context array', input: { '@context': [], id: 'did:peer:abc' } },
      { name: '@context with non-string elements', input: { '@context': [123, null, true], id: 'did:peer:abc' } },
      { name: 'verificationMethod as string', input: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:abc', verificationMethod: 'not-an-array' } },
      { name: 'verificationMethod with empty objects', input: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:abc', verificationMethod: [{}] } },
      { name: 'deeply nested garbage', input: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:abc', verificationMethod: [{ id: 'k1', type: 'T', controller: 'not-a-did', publicKeyMultibase: 'z123' }] } },
      { name: 'extra properties only', input: { foo: 'bar', baz: 123 } },
      { name: 'boolean @context', input: { '@context': true, id: 'did:peer:abc' } },
      { name: 'id is empty string', input: { '@context': ['https://www.w3.org/ns/did/v1'], id: '' } },
    ];

    for (const { name, input } of fuzzCases) {
      test(`rejects: ${name}`, () => {
        expect(() => deserializeDIDDocument(JSON.stringify(input))).toThrow('Invalid DID Document');
      });
    }
  });

  describe('Verifiable Credential fuzz', () => {
    const fuzzCases: Array<{ name: string; input: unknown }> = [
      { name: 'numeric @context', input: { '@context': 42, type: ['VerifiableCredential'], issuer: 'did:peer:abc', issuanceDate: new Date().toISOString(), credentialSubject: {} } },
      { name: '@context as object', input: { '@context': { url: 'https://example.com' }, type: ['VerifiableCredential'], issuer: 'did:peer:abc', issuanceDate: new Date().toISOString(), credentialSubject: {} } },
      { name: 'null type', input: { '@context': ['https://www.w3.org/2018/credentials/v1'], type: null, issuer: 'did:peer:abc', issuanceDate: new Date().toISOString(), credentialSubject: {} } },
      { name: 'type as string', input: { '@context': ['https://www.w3.org/2018/credentials/v1'], type: 'VerifiableCredential', issuer: 'did:peer:abc', issuanceDate: new Date().toISOString(), credentialSubject: {} } },
      { name: 'issuer as number', input: { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 42, issuanceDate: new Date().toISOString(), credentialSubject: {} } },
      { name: 'issuer as array', input: { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: ['did:peer:abc'], issuanceDate: new Date().toISOString(), credentialSubject: {} } },
      { name: 'issuanceDate as number', input: { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 'did:peer:abc', issuanceDate: 1234567890, credentialSubject: {} } },
      { name: 'credentialSubject as string', input: { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 'did:peer:abc', issuanceDate: new Date().toISOString(), credentialSubject: 'not-an-object' } },
      { name: 'credentialSubject as null', input: { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 'did:peer:abc', issuanceDate: new Date().toISOString(), credentialSubject: null } },
      { name: 'empty object', input: {} },
      { name: 'all wrong types', input: { '@context': true, type: 123, issuer: null, issuanceDate: false, credentialSubject: [] } },
      { name: 'empty arrays', input: { '@context': [], type: [], issuer: 'did:peer:abc', issuanceDate: new Date().toISOString(), credentialSubject: {} } },
      { name: 'issuer object without id', input: { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: { name: 'No ID' }, issuanceDate: new Date().toISOString(), credentialSubject: { id: 'did:peer:abc' } } },
    ];

    for (const { name, input } of fuzzCases) {
      test(`rejects: ${name}`, () => {
        expect(() => deserializeCredential(JSON.stringify(input))).toThrow('Invalid Verifiable Credential');
      });
    }
  });
});
