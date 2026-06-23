import { describe, test, expect } from 'bun:test';
import { witnessEvent } from '../../../src/cel/algorithms/witnessEvent';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { canonicalizeEntryForChain } from '../../../src/cel/canonicalize';
import { computeDigestMultibase } from '../../../src/cel/hash';
import type { DataIntegrityProof, WitnessProof, LogEntry, CreateOptions } from '../../../src/cel/types';
import type { WitnessService } from '../../../src/cel/witnesses/WitnessService';
import { computeDigestMultibase } from '../../../src/cel/hash';
import { canonicalizeEntryForChain } from '../../../src/cel/canonicalize';

/**
 * Witness service that records the digestMultibase it was asked to attest to.
 */
function createDigestCapturingWitnessService(): WitnessService & { lastDigest?: string } {
  const service: WitnessService & { lastDigest?: string } = {
    async witness(digestMultibase: string): Promise<WitnessProof> {
      service.lastDigest = digestMultibase;
      return {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: 'did:key:z6MkWitness#key-1',
        proofPurpose: 'assertionMethod',
        proofValue: 'z' + Buffer.from('witness-' + digestMultibase).toString('base64'),
        witnessedAt: new Date().toISOString(),
      };
    },
  };
  return service;
}

/**
 * Mock signer that creates a valid DataIntegrityProof structure.
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

/**
 * Mock witness service that creates valid WitnessProof structures.
 */
function createMockWitnessService(options?: {
  witnessId?: string;
  includeWitnessedAt?: boolean;
  cryptosuite?: string;
}): WitnessService {
  const {
    witnessId = 'did:key:z6MkWitness123',
    includeWitnessedAt = true,
    cryptosuite = 'eddsa-jcs-2022',
  } = options || {};

  return {
    async witness(digestMultibase: string): Promise<WitnessProof> {
      const proof: WitnessProof = {
        type: 'DataIntegrityProof',
        cryptosuite,
        created: new Date().toISOString(),
        verificationMethod: witnessId + '#key-1',
        proofPurpose: 'assertionMethod',
        proofValue: 'z' + Buffer.from('witness-' + digestMultibase).toString('base64'),
        witnessedAt: includeWitnessedAt ? new Date().toISOString() : undefined as unknown as string,
      };
      return proof;
    },
  };
}

/**
 * Mock witness service that returns invalid proofs for testing error handling.
 */
function createInvalidWitnessService(missingField: 'type' | 'cryptosuite' | 'proofValue' | 'witnessedAt'): WitnessService {
  return {
    async witness(digestMultibase: string): Promise<WitnessProof> {
      const validProof: WitnessProof = {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: 'did:key:z6MkWitness#key-1',
        proofPurpose: 'assertionMethod',
        proofValue: 'zMockWitnessProof',
        witnessedAt: new Date().toISOString(),
      };

      // Remove the specified field
      if (missingField === 'type') validProof.type = '';
      if (missingField === 'cryptosuite') validProof.cryptosuite = '';
      if (missingField === 'proofValue') validProof.proofValue = '';
      if (missingField === 'witnessedAt') delete (validProof as Partial<WitnessProof>).witnessedAt;

      return validProof;
    },
  };
}

describe('witnessEvent', () => {
  const verificationMethod = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

  /**
   * Helper to create a test event log with a single event.
   */
  async function createTestEvent(): Promise<LogEntry> {
    const data = { name: 'Test Asset', description: 'A test asset' };
    const options: CreateOptions = {
      signer: createMockSigner(verificationMethod),
      verificationMethod,
      proofPurpose: 'assertionMethod',
    };
    const log = await createEventLog(data, options);
    return log.events[0];
  }

  describe('basic functionality', () => {
    test('adds witness proof to event', async () => {
      const event = await createTestEvent();
      const witness = createMockWitnessService();

      const witnessedEvent = await witnessEvent(event, witness);

      expect(witnessedEvent.proof).toHaveLength(2);
    });

    test('preserves original controller proof', async () => {
      const event = await createTestEvent();
      const originalProof = event.proof[0];
      const witness = createMockWitnessService();

      const witnessedEvent = await witnessEvent(event, witness);

      expect(witnessedEvent.proof[0]).toEqual(originalProof);
    });

    test('appends witness proof to proof array', async () => {
      const event = await createTestEvent();
      const witness = createMockWitnessService({ witnessId: 'did:key:z6MkSpecificWitness' });

      const witnessedEvent = await witnessEvent(event, witness);
      const witnessProof = witnessedEvent.proof[1] as WitnessProof;

      expect(witnessProof.verificationMethod).toContain('did:key:z6MkSpecificWitness');
    });

    test('witness proof has witnessedAt timestamp', async () => {
      const event = await createTestEvent();
      const witness = createMockWitnessService();

      const witnessedEvent = await witnessEvent(event, witness);
      const witnessProof = witnessedEvent.proof[1] as WitnessProof;

      expect(witnessProof.witnessedAt).toBeDefined();
      expect(() => new Date(witnessProof.witnessedAt)).not.toThrow();
    });

    test('does not modify original event (immutability)', async () => {
      const event = await createTestEvent();
      const originalProofLength = event.proof.length;
      const witness = createMockWitnessService();

      await witnessEvent(event, witness);

      // Original event should be unchanged
      expect(event.proof.length).toBe(originalProofLength);
    });

    test('returns new LogEntry instance', async () => {
      const event = await createTestEvent();
      const witness = createMockWitnessService();

      const witnessedEvent = await witnessEvent(event, witness);

      expect(witnessedEvent).not.toBe(event);
      expect(witnessedEvent.proof).not.toBe(event.proof);
    });
  });

  describe('witness proof structure', () => {
    test('witness proof has type DataIntegrityProof', async () => {
      const event = await createTestEvent();
      const witness = createMockWitnessService();

      const witnessedEvent = await witnessEvent(event, witness);
      const witnessProof = witnessedEvent.proof[1];

      expect(witnessProof.type).toBe('DataIntegrityProof');
    });

    test('witness proof has cryptosuite', async () => {
      const event = await createTestEvent();
      const witness = createMockWitnessService({ cryptosuite: 'ecdsa-rdfc-2022' });

      const witnessedEvent = await witnessEvent(event, witness);
      const witnessProof = witnessedEvent.proof[1];

      expect(witnessProof.cryptosuite).toBe('ecdsa-rdfc-2022');
    });

    test('witness proof has proofValue', async () => {
      const event = await createTestEvent();
      const witness = createMockWitnessService();

      const witnessedEvent = await witnessEvent(event, witness);
      const witnessProof = witnessedEvent.proof[1];

      expect(witnessProof.proofValue).toBeDefined();
      expect(witnessProof.proofValue.length).toBeGreaterThan(0);
    });

    test('witness proof has verificationMethod', async () => {
      const event = await createTestEvent();
      const witnessId = 'did:key:z6MkTestWitness';
      const witness = createMockWitnessService({ witnessId });

      const witnessedEvent = await witnessEvent(event, witness);
      const witnessProof = witnessedEvent.proof[1];

      expect(witnessProof.verificationMethod).toContain(witnessId);
    });
  });

  describe('multiple witnesses', () => {
    test('can add multiple witness proofs', async () => {
      const event = await createTestEvent();
      const witness1 = createMockWitnessService({ witnessId: 'did:key:z6MkWitness1' });
      const witness2 = createMockWitnessService({ witnessId: 'did:key:z6MkWitness2' });

      const witnessedOnce = await witnessEvent(event, witness1);
      const witnessedTwice = await witnessEvent(witnessedOnce, witness2);

      expect(witnessedTwice.proof).toHaveLength(3);
    });

    test('preserves all previous proofs when adding multiple witnesses', async () => {
      const event = await createTestEvent();
      const originalProof = event.proof[0];
      const witness1 = createMockWitnessService({ witnessId: 'did:key:z6MkWitness1' });
      const witness2 = createMockWitnessService({ witnessId: 'did:key:z6MkWitness2' });

      const witnessedOnce = await witnessEvent(event, witness1);
      const witnessedTwice = await witnessEvent(witnessedOnce, witness2);

      expect(witnessedTwice.proof[0]).toEqual(originalProof);
      expect((witnessedTwice.proof[1] as WitnessProof).verificationMethod).toContain('z6MkWitness1');
      expect((witnessedTwice.proof[2] as WitnessProof).verificationMethod).toContain('z6MkWitness2');
    });
  });

  describe('error handling', () => {
    test('throws error when event is null', async () => {
      const witness = createMockWitnessService();

      await expect(witnessEvent(null as unknown as LogEntry, witness)).rejects.toThrow('Event is required');
    });

    test('throws error when event is undefined', async () => {
      const witness = createMockWitnessService();

      await expect(witnessEvent(undefined as unknown as LogEntry, witness)).rejects.toThrow('Event is required');
    });

    test('throws error when event has no proofs', async () => {
      const eventWithoutProof: LogEntry = {
        type: 'create',
        data: { name: 'Test' },
        proof: [],
      };
      const witness = createMockWitnessService();

      await expect(witnessEvent(eventWithoutProof, witness)).rejects.toThrow('at least one proof');
    });

    test('throws error when witness is null', async () => {
      const event = await createTestEvent();

      await expect(witnessEvent(event, null as unknown as WitnessService)).rejects.toThrow('Witness service is required');
    });

    test('throws error when witness proof is missing type', async () => {
      const event = await createTestEvent();
      const invalidWitness = createInvalidWitnessService('type');

      await expect(witnessEvent(event, invalidWitness)).rejects.toThrow('Invalid witness proof');
    });

    test('throws error when witness proof is missing cryptosuite', async () => {
      const event = await createTestEvent();
      const invalidWitness = createInvalidWitnessService('cryptosuite');

      await expect(witnessEvent(event, invalidWitness)).rejects.toThrow('Invalid witness proof');
    });

    test('throws error when witness proof is missing proofValue', async () => {
      const event = await createTestEvent();
      const invalidWitness = createInvalidWitnessService('proofValue');

      await expect(witnessEvent(event, invalidWitness)).rejects.toThrow('Invalid witness proof');
    });

    test('throws error when witness proof is missing witnessedAt', async () => {
      const event = await createTestEvent();
      const invalidWitness = createInvalidWitnessService('witnessedAt');

      await expect(witnessEvent(event, invalidWitness)).rejects.toThrow('missing witnessedAt');
    });

    test('propagates witness service errors', async () => {
      const event = await createTestEvent();
      const failingWitness: WitnessService = {
        async witness(): Promise<WitnessProof> {
          throw new Error('Witness service unavailable');
        },
      };

      await expect(witnessEvent(event, failingWitness)).rejects.toThrow('Witness service unavailable');
    });
  });

  describe('digest scope (committed fields only)', () => {
    test('digest is computed over committed fields only, not the proof array', async () => {
      const event = await createTestEvent();
      const witness = createDigestCapturingWitnessService();

      await witnessEvent(event, witness);

      const expected = computeDigestMultibase(canonicalizeEntryForChain(event));
      expect(witness.lastDigest).toBe(expected);
    });

    test('mutating the proof array does not change the witness digest', async () => {
      const event = await createTestEvent();

      // Same committed fields, but a different/mutated proof array.
      const mutatedEvent: LogEntry = {
        ...event,
        proof: [
          { ...event.proof[0], created: '1999-01-01T00:00:00Z', verificationMethod: 'did:key:zMutated#k' },
          // An extra proof appended after the fact (e.g. a prior witness).
          {
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: 'did:key:z6MkOtherWitness#key-1',
            proofPurpose: 'assertionMethod',
            proofValue: 'zSomeOtherProofValue',
            witnessedAt: new Date().toISOString(),
          } as WitnessProof,
        ],
      };

      const witnessA = createDigestCapturingWitnessService();
      const witnessB = createDigestCapturingWitnessService();

      await witnessEvent(event, witnessA);
      await witnessEvent(mutatedEvent, witnessB);

      expect(witnessB.lastDigest).toBe(witnessA.lastDigest);
    });

    test('changing committed data does change the witness digest', async () => {
      const event = await createTestEvent();
      const changedEvent: LogEntry = { ...event, data: { ...((event.data as object) ?? {}), name: 'Different' } };

      const witnessA = createDigestCapturingWitnessService();
      const witnessB = createDigestCapturingWitnessService();

      await witnessEvent(event, witnessA);
      await witnessEvent(changedEvent, witnessB);

      expect(witnessB.lastDigest).not.toBe(witnessA.lastDigest);
    });
  });

  describe('event data preservation', () => {
    test('preserves event type', async () => {
      const event = await createTestEvent();
      const witness = createMockWitnessService();

      const witnessedEvent = await witnessEvent(event, witness);

      expect(witnessedEvent.type).toBe(event.type);
    });

    test('preserves event data', async () => {
      const event = await createTestEvent();
      const witness = createMockWitnessService();

      const witnessedEvent = await witnessEvent(event, witness);

      expect(witnessedEvent.data).toEqual(event.data);
    });

    test('preserves previousEvent if present', async () => {
      const event: LogEntry = {
        type: 'update',
        data: { name: 'Updated Asset' },
        previousEvent: 'uSomeHashValue',
        proof: [{
          type: 'DataIntegrityProof',
          cryptosuite: 'eddsa-jcs-2022',
          created: new Date().toISOString(),
          verificationMethod,
          proofPurpose: 'assertionMethod',
          proofValue: 'zMockSignature',
        }],
      };
      const witness = createMockWitnessService();

      const witnessedEvent = await witnessEvent(event, witness);

      expect(witnessedEvent.previousEvent).toBe('uSomeHashValue');
    });
  });

  describe('digest consistency with the hash chain (cross-tool serialization)', () => {
    /**
     * A witness service that records the digest it was asked to attest to.
     */
    function createCapturingWitness(): { service: WitnessService; captured: string[] } {
      const captured: string[] = [];
      const service: WitnessService = {
        async witness(digestMultibase: string): Promise<WitnessProof> {
          captured.push(digestMultibase);
          return {
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: 'did:key:z6MkWitness123#key-1',
            proofPurpose: 'assertionMethod',
            proofValue: 'z' + Buffer.from('witness-' + digestMultibase).toString('base64'),
            witnessedAt: new Date().toISOString(),
          };
        },
      };
      return { service, captured };
    }

    test('witnesses the chain digest (canonicalizeEntryForChain) for a first event', async () => {
      const event = await createTestEvent();
      const { service, captured } = createCapturingWitness();

      await witnessEvent(event, service);

      const expected = computeDigestMultibase(canonicalizeEntryForChain(event));
      expect(captured).toHaveLength(1);
      expect(captured[0]).toBe(expected);
    });

    test('witnesses the chain digest for an event WITH previousEvent', async () => {
      const event: LogEntry = {
        type: 'update',
        data: { name: 'Updated Asset', nested: { a: 1, b: [2, 3] } },
        previousEvent: 'uSomePreviousHash',
        proof: [{
          type: 'DataIntegrityProof',
          cryptosuite: 'eddsa-jcs-2022',
          created: new Date().toISOString(),
          verificationMethod,
          proofPurpose: 'assertionMethod',
          proofValue: 'zMockSignature',
        }],
      };
      const { service, captured } = createCapturingWitness();

      await witnessEvent(event, service);

      const expected = computeDigestMultibase(canonicalizeEntryForChain(event));
      expect(captured[0]).toBe(expected);
    });

    test('witnessed digest is independent of the proof array', async () => {
      // Two events that are identical in their committed fields {type, data,
      // previousEvent} but differ in their proof contents must be witnessed over
      // the SAME digest. This fails with a proof-inclusive serializer.
      const committed = {
        type: 'update',
        data: { name: 'Same Committed Data' },
        previousEvent: 'uSamePreviousHash',
      };
      const eventA: LogEntry = {
        ...committed,
        proof: [{
          type: 'DataIntegrityProof',
          cryptosuite: 'eddsa-jcs-2022',
          created: '2020-01-01T00:00:00Z',
          verificationMethod: verificationMethod + '-A',
          proofPurpose: 'assertionMethod',
          proofValue: 'zSignatureA',
        }],
      };
      const eventB: LogEntry = {
        ...committed,
        proof: [{
          type: 'DataIntegrityProof',
          cryptosuite: 'eddsa-jcs-2022',
          created: '2099-12-31T23:59:59Z',
          verificationMethod: verificationMethod + '-B',
          proofPurpose: 'assertionMethod',
          proofValue: 'zCompletelyDifferentSignatureB',
        }],
      };

      const { service, captured } = createCapturingWitness();
      await witnessEvent(eventA, service);
      await witnessEvent(eventB, service);

      expect(captured[0]).toBe(captured[1]);
    });
  });
});
