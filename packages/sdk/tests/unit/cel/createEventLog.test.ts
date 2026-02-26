import { describe, test, expect } from 'bun:test';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import type { DataIntegrityProof, EventLog, CreateOptions } from '../../../src/cel/types';

/**
 * Mock signer that creates a valid DataIntegrityProof structure.
 * In production, this would use actual Ed25519 signing with eddsa-jcs-2022.
 */
function createMockSigner(verificationMethod: string) {
  return async (data: unknown): Promise<DataIntegrityProof> => {
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue: 'z' + Buffer.from('mock-signature-' + JSON.stringify(data)).toString('base64'),
    };
  };
}

describe('createEventLog', () => {
  const verificationMethod = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

  describe('basic functionality', () => {
    test('creates an event log with a single create event', async () => {
      const data = { name: 'Test Asset', description: 'A test asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
        proofPurpose: 'assertionMethod',
      };

      const log = await createEventLog(data, options);

      expect(log).toBeDefined();
      expect(log.events).toBeInstanceOf(Array);
      expect(log.events).toHaveLength(1);
    });

    test('first event has type "create"', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);

      expect(log.events[0].type).toBe('create');
    });

    test('first event has no previousEvent', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);

      expect(log.events[0].previousEvent).toBeUndefined();
    });

    test('event contains the provided data', async () => {
      const data = { 
        name: 'My Original', 
        resources: [{ digestMultibase: 'uXYZ123' }],
        metadata: { custom: 'value' }
      };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);

      expect(log.events[0].data).toEqual({ ...data, operation: 'ResourceAdded' });
    });

    test('normalizes create event with ResourceAdded operation', async () => {
      const data = { name: 'Op Test' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);
      expect((log.events[0].data as Record<string, unknown>).operation).toBe('ResourceAdded');
    });
  });

  describe('proof generation', () => {
    test('event has at least one proof', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);

      expect(log.events[0].proof).toBeInstanceOf(Array);
      expect(log.events[0].proof.length).toBeGreaterThanOrEqual(1);
    });

    test('proof uses eddsa-jcs-2022 cryptosuite', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);
      const proof = log.events[0].proof[0];

      expect(proof.cryptosuite).toBe('eddsa-jcs-2022');
    });

    test('proof has type DataIntegrityProof', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);
      const proof = log.events[0].proof[0];

      expect(proof.type).toBe('DataIntegrityProof');
    });

    test('proof includes verificationMethod', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);
      const proof = log.events[0].proof[0];

      expect(proof.verificationMethod).toBe(verificationMethod);
    });

    test('proof includes proofValue', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);
      const proof = log.events[0].proof[0];

      expect(proof.proofValue).toBeDefined();
      expect(typeof proof.proofValue).toBe('string');
      expect(proof.proofValue.length).toBeGreaterThan(0);
    });

    test('proof includes created timestamp', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);
      const proof = log.events[0].proof[0];

      expect(proof.created).toBeDefined();
      // Verify it's a valid ISO timestamp
      expect(() => new Date(proof.created)).not.toThrow();
    });

    test('proof includes proofPurpose', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
        proofPurpose: 'assertionMethod',
      };

      const log = await createEventLog(data, options);
      const proof = log.events[0].proof[0];

      expect(proof.proofPurpose).toBe('assertionMethod');
    });
  });

  describe('options handling', () => {
    test('uses default proofPurpose when not specified', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
        // proofPurpose not specified
      };

      const log = await createEventLog(data, options);
      const proof = log.events[0].proof[0];

      // Should use default 'assertionMethod'
      expect(proof.proofPurpose).toBe('assertionMethod');
    });

    test('uses custom proofPurpose when specified', async () => {
      // Create a signer that respects custom proofPurpose
      const customSigner = async (data: unknown): Promise<DataIntegrityProof> => {
        return {
          type: 'DataIntegrityProof',
          cryptosuite: 'eddsa-jcs-2022',
          created: new Date().toISOString(),
          verificationMethod,
          proofPurpose: 'authentication',
          proofValue: 'zMockSignature',
        };
      };

      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: customSigner,
        verificationMethod,
        proofPurpose: 'authentication',
      };

      const log = await createEventLog(data, options);
      const proof = log.events[0].proof[0];

      expect(proof.proofPurpose).toBe('authentication');
    });
  });

  describe('error handling', () => {
    test('throws error when signer returns invalid proof', async () => {
      const invalidSigner = async (): Promise<DataIntegrityProof> => {
        return {
          type: '',
          cryptosuite: '',
          created: '',
          verificationMethod: '',
          proofPurpose: '',
          proofValue: '',
        };
      };

      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: invalidSigner,
        verificationMethod,
      };

      await expect(createEventLog(data, options)).rejects.toThrow('Invalid proof');
    });

    test('throws error when proof uses non-v1.1 cryptosuite', async () => {
      const invalidSuiteSigner = async (): Promise<DataIntegrityProof> => ({
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-rdfc-2022',
        created: new Date().toISOString(),
        verificationMethod,
        proofPurpose: 'assertionMethod',
        proofValue: 'zMockSignature',
      });

      await expect(createEventLog({ name: 'Test Asset' }, {
        signer: invalidSuiteSigner,
        verificationMethod,
      })).rejects.toThrow('Invalid proof cryptosuite for required event');
    });
  });

  describe('event log structure', () => {
    test('event log has no previousLog for new logs', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);

      expect(log.previousLog).toBeUndefined();
    });

    test('event log is valid EventLog type', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log: EventLog = await createEventLog(data, options);

      // Type assertion ensures compile-time check
      expect(log.events).toBeDefined();
    });
  });

  describe('data preservation', () => {
    test('handles complex nested data', async () => {
      const complexData = {
        name: 'Complex Asset',
        resources: [
          { url: ['https://example.com/image.png'], mediaType: 'image/png', digestMultibase: 'uABC123' },
          { url: ['https://example.com/video.mp4'], mediaType: 'video/mp4', digestMultibase: 'uDEF456' },
        ],
        metadata: {
          creator: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
          createdAt: '2026-01-20T12:00:00Z',
          tags: ['art', 'digital', 'original'],
          nested: {
            level1: {
              level2: {
                value: 'deep',
              },
            },
          },
        },
      };

      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(complexData, options);

      expect(log.events[0].data).toEqual({ ...complexData, operation: 'ResourceAdded' });
    });

    test('handles null and undefined values in data', async () => {
      const dataWithNulls = {
        name: 'Asset',
        description: null,
        optional: undefined,
      };

      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(dataWithNulls, options);

      expect(log.events[0].data).toEqual({ ...dataWithNulls, operation: 'ResourceAdded' });
    });
  });
});
