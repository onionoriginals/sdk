import { describe, test, expect, spyOn } from 'bun:test';
import { canonize, canonizeProof } from '../../../src/vc/utils/jsonld';
import jsonld from 'jsonld';

describe('jsonld utils', () => {
  describe('canonize', () => {
    test('canonizes JSON-LD document', async () => {
      const input = {
        '@context': 'https://www.w3.org/ns/credentials/v2',
        'type': 'VerifiableCredential',
        'issuer': 'did:example:123'
      };

      const documentLoader = async (url: string) => {
        if (url === 'https://www.w3.org/ns/credentials/v2') {
          return {
            contextUrl: null,
            document: {
              '@context': {
                '@version': 1.1,
                'type': '@type',
                'issuer': '@id'
              }
            },
            documentUrl: url
          };
        }
        throw new Error(`Unknown context: ${url}`);
      };

      const result = await canonize(input, { documentLoader });

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('did:example:123');
    });

    test('calls jsonld.canonize with correct options', async () => {
      const input = {
        '@context': 'https://example.org/context',
        'name': 'Test'
      };

      const documentLoader = async () => ({
        contextUrl: null,
        document: { '@context': {} },
        documentUrl: ''
      });

      const canonizeSpy = spyOn(jsonld, 'canonize');

      await canonize(input, { documentLoader });

      expect(canonizeSpy).toHaveBeenCalledWith(
        input,
        {
          algorithm: 'URDNA2015',
          format: 'application/n-quads',
          documentLoader,
          safe: false,
          useNative: false,
          rdfDirection: 'i18n-datatype'
        }
      );

      canonizeSpy.mockRestore();
    });

    test('handles empty document', async () => {
      const input = { '@context': 'https://example.org' };
      const documentLoader = async () => ({
        contextUrl: null,
        document: { '@context': {} },
        documentUrl: ''
      });

      const result = await canonize(input, { documentLoader });
      expect(typeof result).toBe('string');
    });

    test('handles arrays in input', async () => {
      const input = {
        '@context': 'https://example.org',
        'items': ['a', 'b', 'c']
      };
      const documentLoader = async () => ({
        contextUrl: null,
        document: { '@context': { 'items': '@list' } },
        documentUrl: ''
      });

      const result = await canonize(input, { documentLoader });
      expect(typeof result).toBe('string');
    });
  });

  describe('canonizeProof', () => {
    test('removes jws field from proof', async () => {
      const proof = {
        '@context': 'https://w3id.org/security/v2',
        'type': 'Ed25519Signature2020',
        'created': '2023-01-01T00:00:00Z',
        'jws': 'eyJhbGciOiJFZERTQSJ9..signature',
        'verificationMethod': 'did:example:123#key-1'
      };

      const documentLoader = async () => ({
        contextUrl: null,
        document: { '@context': {} },
        documentUrl: ''
      });

      const canonizeSpy = spyOn(jsonld, 'canonize');

      await canonizeProof(proof, { documentLoader });

      const calledWith = canonizeSpy.mock.calls[0][0];
      expect(calledWith).not.toHaveProperty('jws');
      expect(calledWith).toHaveProperty('type');
      expect(calledWith).toHaveProperty('created');
      expect(calledWith).toHaveProperty('verificationMethod');

      canonizeSpy.mockRestore();
    });

    test('removes signatureValue field from proof', async () => {
      const proof = {
        '@context': 'https://w3id.org/security/v2',
        'type': 'DataIntegrityProof',
        'created': '2023-01-01T00:00:00Z',
        'signatureValue': 'z3eF7Gh8...',
        'proofPurpose': 'assertionMethod'
      };

      const documentLoader = async () => ({
        contextUrl: null,
        document: { '@context': {} },
        documentUrl: ''
      });

      const canonizeSpy = spyOn(jsonld, 'canonize');

      await canonizeProof(proof, { documentLoader });

      const calledWith = canonizeSpy.mock.calls[0][0];
      expect(calledWith).not.toHaveProperty('signatureValue');
      expect(calledWith).toHaveProperty('type');
      expect(calledWith).toHaveProperty('created');

      canonizeSpy.mockRestore();
    });

    test('removes proofValue field from proof', async () => {
      const proof = {
        '@context': 'https://w3id.org/security/v2',
        'type': 'DataIntegrityProof',
        'created': '2023-01-01T00:00:00Z',
        'proofValue': 'z58DAdFfa9SkqZMVPxAQpic7ndSayn1PzZs6ZjWp1CktyGesjuTSwRdoWhAfGFCF5bppETSTojQCrfFPP2oumHKtz',
        'proofPurpose': 'assertionMethod'
      };

      const documentLoader = async () => ({
        contextUrl: null,
        document: { '@context': {} },
        documentUrl: ''
      });

      const canonizeSpy = spyOn(jsonld, 'canonize');

      await canonizeProof(proof, { documentLoader });

      const calledWith = canonizeSpy.mock.calls[0][0];
      expect(calledWith).not.toHaveProperty('proofValue');
      expect(calledWith).toHaveProperty('type');

      canonizeSpy.mockRestore();
    });

    test('removes all signature fields at once', async () => {
      const proof = {
        '@context': 'https://w3id.org/security/v2',
        'type': 'Ed25519Signature2020',
        'created': '2023-01-01T00:00:00Z',
        'jws': 'eyJhbGciOiJFZERTQSJ9..signature',
        'signatureValue': 'z3eF7Gh8...',
        'proofValue': 'z58DAdFfa...',
        'verificationMethod': 'did:example:123#key-1',
        'proofPurpose': 'assertionMethod'
      };

      const documentLoader = async () => ({
        contextUrl: null,
        document: { '@context': {} },
        documentUrl: ''
      });

      const canonizeSpy = spyOn(jsonld, 'canonize');

      await canonizeProof(proof, { documentLoader });

      const calledWith = canonizeSpy.mock.calls[0][0];
      expect(calledWith).not.toHaveProperty('jws');
      expect(calledWith).not.toHaveProperty('signatureValue');
      expect(calledWith).not.toHaveProperty('proofValue');
      expect(calledWith).toHaveProperty('type');
      expect(calledWith).toHaveProperty('verificationMethod');
      expect(calledWith).toHaveProperty('proofPurpose');

      canonizeSpy.mockRestore();
    });

    test('preserves all non-signature fields', async () => {
      const proof = {
        'type': 'Ed25519Signature2020',
        'created': '2023-01-01T00:00:00Z',
        'verificationMethod': 'did:example:123#key-1',
        'proofPurpose': 'assertionMethod',
        'challenge': 'abc123',
        'domain': 'example.com',
        'jws': 'remove-me'
      };

      const documentLoader = async () => ({
        contextUrl: null,
        document: { '@context': {} },
        documentUrl: ''
      });

      const canonizeSpy = spyOn(jsonld, 'canonize');

      await canonizeProof(proof, { documentLoader });

      const calledWith = canonizeSpy.mock.calls[0][0];
      expect(calledWith.type).toBe('Ed25519Signature2020');
      expect(calledWith.created).toBe('2023-01-01T00:00:00Z');
      expect(calledWith.verificationMethod).toBe('did:example:123#key-1');
      expect(calledWith.proofPurpose).toBe('assertionMethod');
      expect(calledWith.challenge).toBe('abc123');
      expect(calledWith.domain).toBe('example.com');

      canonizeSpy.mockRestore();
    });

    test('handles proof with no signature fields', async () => {
      const proof = {
        'type': 'DataIntegrityProof',
        'created': '2023-01-01T00:00:00Z',
        'proofPurpose': 'assertionMethod'
      };

      const documentLoader = async () => ({
        contextUrl: null,
        document: { '@context': {} },
        documentUrl: ''
      });

      const result = await canonizeProof(proof, { documentLoader });
      expect(typeof result).toBe('string');
    });
  });

  describe('integration between canonize and canonizeProof', () => {
    test('canonizeProof internally uses canonize', async () => {
      const proof = {
        'type': 'Ed25519Signature2020',
        'jws': 'should-be-removed'
      };

      const documentLoader = async () => ({
        contextUrl: null,
        document: { '@context': {} },
        documentUrl: ''
      });

      const canonizeSpy = spyOn(jsonld, 'canonize');

      await canonizeProof(proof, { documentLoader });

      expect(canonizeSpy).toHaveBeenCalled();

      canonizeSpy.mockRestore();
    });
  });
});
