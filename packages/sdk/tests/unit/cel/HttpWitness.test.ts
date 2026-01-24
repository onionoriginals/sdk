/**
 * HttpWitness Unit Tests
 * 
 * Tests for the HTTP-based witness service implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpWitness, HttpWitnessError } from '../../../src/cel/witnesses/HttpWitness';
import type { WitnessProof } from '../../../src/cel/types';

describe('HttpWitness', () => {
  // Valid WitnessProof for testing
  const validWitnessProof: WitnessProof = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2026-01-20T12:00:00Z',
    verificationMethod: 'did:web:witness.example.com#key-1',
    proofPurpose: 'assertionMethod',
    proofValue: 'z3FXQqFX8G...base58encoded',
    witnessedAt: '2026-01-20T12:00:01Z',
  };

  // Test digest
  const testDigest = 'uEiDf4P8v1...base64urlEncoded';

  describe('constructor', () => {
    it('accepts a valid witness URL', () => {
      const witness = new HttpWitness('https://witness.example.com/api/attest');
      expect(witness.url).toBe('https://witness.example.com/api/attest');
    });

    it('throws error for empty witness URL', () => {
      expect(() => new HttpWitness('')).toThrow('witnessUrl must be a non-empty string');
    });

    it('throws error for null witness URL', () => {
      expect(() => new HttpWitness(null as unknown as string)).toThrow('witnessUrl must be a non-empty string');
    });

    it('throws error for invalid URL format', () => {
      expect(() => new HttpWitness('not-a-valid-url')).toThrow('Invalid witness URL');
    });

    it('accepts custom options', () => {
      const mockFetch = vi.fn();
      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        timeout: 5000,
        headers: { 'X-Custom-Header': 'value' },
        fetch: mockFetch,
      });
      expect(witness.url).toBe('https://witness.example.com/api/attest');
    });

    it('accepts HTTP URLs', () => {
      const witness = new HttpWitness('http://localhost:3000/witness');
      expect(witness.url).toBe('http://localhost:3000/witness');
    });
  });

  describe('witness()', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
    });

    it('posts digestMultibase to witness endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => validWitnessProof,
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      await witness.witness(testDigest);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://witness.example.com/api/attest',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ digest: testDigest }),
        })
      );
    });

    it('returns valid WitnessProof from response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => validWitnessProof,
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      const proof = await witness.witness(testDigest);

      expect(proof).toEqual(validWitnessProof);
      expect(proof.witnessedAt).toBe('2026-01-20T12:00:01Z');
      expect(proof.type).toBe('DataIntegrityProof');
      expect(proof.cryptosuite).toBe('eddsa-jcs-2022');
    });

    it('throws error for empty digestMultibase', async () => {
      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      await expect(witness.witness('')).rejects.toThrow('digestMultibase must be a non-empty string');
    });

    it('throws error for null digestMultibase', async () => {
      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      await expect(witness.witness(null as unknown as string)).rejects.toThrow('digestMultibase must be a non-empty string');
    });

    it('includes custom headers in request', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => validWitnessProof,
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
        headers: { 'Authorization': 'Bearer token123', 'X-API-Key': 'key456' },
      });

      await witness.witness(testDigest);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer token123',
            'X-API-Key': 'key456',
          }),
        })
      );
    });
  });

  describe('error handling', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
    });

    it('throws HttpWitnessError for 404 response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Endpoint not found',
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      await expect(witness.witness(testDigest)).rejects.toThrow(HttpWitnessError);
      await expect(witness.witness(testDigest)).rejects.toThrow('Witness service returned 404 Not Found');
    });

    it('throws HttpWitnessError for 500 response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error',
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      try {
        await witness.witness(testDigest);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpWitnessError);
        const httpError = error as HttpWitnessError;
        expect(httpError.statusCode).toBe(500);
        expect(httpError.witnessUrl).toBe('https://witness.example.com/api/attest');
        expect(httpError.responseBody).toBe('Server error');
      }
    });

    it('throws HttpWitnessError for 401 unauthorized', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid credentials',
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      try {
        await witness.witness(testDigest);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpWitnessError);
        const httpError = error as HttpWitnessError;
        expect(httpError.statusCode).toBe(401);
      }
    });

    it('throws HttpWitnessError for network errors', async () => {
      mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      await expect(witness.witness(testDigest)).rejects.toThrow(HttpWitnessError);
      await expect(witness.witness(testDigest)).rejects.toThrow('Witness service unavailable');
    });

    it('throws HttpWitnessError for timeout', async () => {
      mockFetch.mockImplementation(async (_url, options) => {
        // Simulate abort
        if (options?.signal) {
          const abortError = new Error('Aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }
        throw new Error('Unexpected');
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
        timeout: 100,
      });

      await expect(witness.witness(testDigest)).rejects.toThrow('timed out');
    });

    it('throws HttpWitnessError for invalid JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => { throw new Error('Invalid JSON'); },
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      await expect(witness.witness(testDigest)).rejects.toThrow('invalid JSON response');
    });

    it('throws HttpWitnessError when response is not an object', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => 'not an object',
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      await expect(witness.witness(testDigest)).rejects.toThrow('expected object');
    });

    it('throws HttpWitnessError when response is null', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => null,
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      await expect(witness.witness(testDigest)).rejects.toThrow('expected object');
    });
  });

  describe('WitnessProof validation', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
    });

    const requiredFields = [
      'type',
      'cryptosuite',
      'created',
      'verificationMethod',
      'proofPurpose',
      'proofValue',
      'witnessedAt',
    ];

    for (const field of requiredFields) {
      it(`throws error when '${field}' is missing`, async () => {
        const invalidProof = { ...validWitnessProof };
        delete (invalidProof as Record<string, unknown>)[field];

        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => invalidProof,
        });

        const witness = new HttpWitness('https://witness.example.com/api/attest', {
          fetch: mockFetch,
        });

        await expect(witness.witness(testDigest)).rejects.toThrow(`'${field}'`);
      });

      it(`throws error when '${field}' is not a string`, async () => {
        const invalidProof = {
          ...validWitnessProof,
          [field]: 123,
        };

        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => invalidProof,
        });

        const witness = new HttpWitness('https://witness.example.com/api/attest', {
          fetch: mockFetch,
        });

        await expect(witness.witness(testDigest)).rejects.toThrow(`'${field}'`);
      });
    }

    it('accepts proof with extra fields', async () => {
      const proofWithExtras = {
        ...validWitnessProof,
        extraField: 'should be ignored',
        anotherExtra: 123,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => proofWithExtras,
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      const proof = await witness.witness(testDigest);

      // Extra fields should NOT be in the returned proof
      expect(proof).toEqual(validWitnessProof);
      expect((proof as Record<string, unknown>).extraField).toBeUndefined();
    });
  });

  describe('HttpWitnessError', () => {
    it('has correct properties', () => {
      const error = new HttpWitnessError(
        'Test error message',
        'https://witness.example.com/api/attest',
        500,
        'Server error body'
      );

      expect(error.name).toBe('HttpWitnessError');
      expect(error.message).toBe('Test error message');
      expect(error.witnessUrl).toBe('https://witness.example.com/api/attest');
      expect(error.statusCode).toBe(500);
      expect(error.responseBody).toBe('Server error body');
    });

    it('works without optional properties', () => {
      const error = new HttpWitnessError(
        'Test error',
        'https://witness.example.com/api/attest'
      );

      expect(error.statusCode).toBeUndefined();
      expect(error.responseBody).toBeUndefined();
    });

    it('is instanceof Error', () => {
      const error = new HttpWitnessError('Test', 'https://example.com');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('integration with WitnessService interface', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
    });

    it('implements WitnessService interface correctly', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => validWitnessProof,
      });

      // Use as WitnessService type
      const witnessService = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      // Should have witness method that matches interface
      expect(typeof witnessService.witness).toBe('function');

      const proof = await witnessService.witness(testDigest);
      expect(proof.witnessedAt).toBeDefined();
    });

    it('can be used with multiple digests sequentially', async () => {
      const digests = ['uEiD111...', 'uEiD222...', 'uEiD333...'];
      
      mockFetch.mockImplementation(async (_url, options) => {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            ...validWitnessProof,
            witnessedAt: new Date().toISOString(),
            proofValue: `proof-for-${body.digest}`,
          }),
        };
      });

      const witness = new HttpWitness('https://witness.example.com/api/attest', {
        fetch: mockFetch,
      });

      for (const digest of digests) {
        const proof = await witness.witness(digest);
        expect(proof.proofValue).toBe(`proof-for-${digest}`);
      }

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('different witness endpoint patterns', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => validWitnessProof,
      });
    });

    it('works with path-based endpoints', async () => {
      const witness = new HttpWitness('https://api.example.com/v1/witness/attest', {
        fetch: mockFetch,
      });
      
      await witness.witness(testDigest);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/witness/attest',
        expect.anything()
      );
    });

    it('works with localhost URLs', async () => {
      const witness = new HttpWitness('http://localhost:8080/witness', {
        fetch: mockFetch,
      });
      
      await witness.witness(testDigest);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/witness',
        expect.anything()
      );
    });

    it('works with IP-based URLs', async () => {
      const witness = new HttpWitness('http://192.168.1.100:3000/api/witness', {
        fetch: mockFetch,
      });
      
      await witness.witness(testDigest);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://192.168.1.100:3000/api/witness',
        expect.anything()
      );
    });

    it('works with URLs containing query parameters', async () => {
      const witness = new HttpWitness('https://witness.example.com/attest?version=2', {
        fetch: mockFetch,
      });
      
      await witness.witness(testDigest);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://witness.example.com/attest?version=2',
        expect.anything()
      );
    });
  });
});
