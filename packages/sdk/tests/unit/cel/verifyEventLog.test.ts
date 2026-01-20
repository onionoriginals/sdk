import { describe, test, expect } from 'bun:test';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import type { 
  EventLog, 
  LogEntry, 
  DataIntegrityProof, 
  CreateOptions,
  VerifyOptions 
} from '../../../src/cel/types';

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

describe('verifyEventLog', () => {
  const verificationMethod = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

  describe('basic verification', () => {
    test('verifies a valid event log with single create event', async () => {
      const data = { name: 'Test Asset' };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(data, options);
      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.events).toHaveLength(1);
    });

    test('verifies a valid event log with multiple events', async () => {
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      let log = await createEventLog({ name: 'Test Asset' }, options);
      log = await updateEventLog(log, { name: 'Updated Asset' }, options);
      log = await updateEventLog(log, { name: 'Final Asset' }, options);

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.events).toHaveLength(3);
    });

    test('returns per-event verification details', async () => {
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      let log = await createEventLog({ name: 'Test Asset' }, options);
      log = await updateEventLog(log, { version: 2 }, options);

      const result = await verifyEventLog(log);

      expect(result.events[0].index).toBe(0);
      expect(result.events[0].type).toBe('create');
      expect(result.events[0].proofValid).toBe(true);

      expect(result.events[1].index).toBe(1);
      expect(result.events[1].type).toBe('update');
      expect(result.events[1].proofValid).toBe(true);
    });
  });

  describe('proof verification', () => {
    test('returns verified: true when proof structure is valid', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod,
            proofPurpose: 'assertionMethod',
            proofValue: 'zValidBase58Signature',
          }],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
    });

    test('returns verified: false when proof type is wrong', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'WrongType',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod,
            proofPurpose: 'assertionMethod',
            proofValue: 'zValidBase58Signature',
          } as DataIntegrityProof],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.events[0].proofValid).toBe(false);
    });

    test('returns verified: false when cryptosuite is missing', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: '',
            created: new Date().toISOString(),
            verificationMethod,
            proofPurpose: 'assertionMethod',
            proofValue: 'zValidBase58Signature',
          }],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
    });

    test('returns verified: false when proofValue is missing', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod,
            proofPurpose: 'assertionMethod',
            proofValue: '',
          }],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
    });

    test('returns verified: false when proofValue has invalid encoding prefix', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod,
            proofPurpose: 'assertionMethod',
            proofValue: 'InvalidEncodingNoPrefix',
          }],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
    });

    test('returns verified: false when verificationMethod is missing', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: '',
            proofPurpose: 'assertionMethod',
            proofValue: 'zValidBase58Signature',
          }],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
    });

    test('accepts eddsa-rdfc-2022 cryptosuite', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-rdfc-2022',
            created: new Date().toISOString(),
            verificationMethod,
            proofPurpose: 'assertionMethod',
            proofValue: 'zValidBase58Signature',
          }],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
    });

    test('returns verified: false for unknown cryptosuite', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'unknown-cryptosuite-2022',
            created: new Date().toISOString(),
            verificationMethod,
            proofPurpose: 'assertionMethod',
            proofValue: 'zValidBase58Signature',
          }],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
    });
  });

  describe('tampered proof detection', () => {
    test('returns verified: false when event has no proofs', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => e.includes('No proofs found'))).toBe(true);
    });

    test('returns verified: false when proof array is missing', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
        } as LogEntry],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
    });

    test('detects tampered proofValue with custom verifier', async () => {
      // Custom verifier that checks for specific signature pattern
      const customVerifier = async (proof: DataIntegrityProof, data: unknown): Promise<boolean> => {
        // This verifier expects proofValue to start with 'zExpected'
        return proof.proofValue.startsWith('zExpected');
      };

      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod,
            proofPurpose: 'assertionMethod',
            proofValue: 'zTamperedSignature',
          }],
        }],
      };

      const result = await verifyEventLog(log, { verifier: customVerifier });

      expect(result.verified).toBe(false);
    });

    test('accepts valid proof with custom verifier', async () => {
      const customVerifier = async (proof: DataIntegrityProof, data: unknown): Promise<boolean> => {
        return proof.proofValue.startsWith('zExpected');
      };

      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod,
            proofPurpose: 'assertionMethod',
            proofValue: 'zExpectedValidSignature',
          }],
        }],
      };

      const result = await verifyEventLog(log, { verifier: customVerifier });

      expect(result.verified).toBe(true);
    });
  });

  describe('error handling', () => {
    test('handles null event log', async () => {
      const result = await verifyEventLog(null as unknown as EventLog);

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => e.includes('Invalid event log'))).toBe(true);
    });

    test('handles undefined event log', async () => {
      const result = await verifyEventLog(undefined as unknown as EventLog);

      expect(result.verified).toBe(false);
    });

    test('handles event log with missing events array', async () => {
      const result = await verifyEventLog({} as EventLog);

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => e.includes('missing events array'))).toBe(true);
    });

    test('handles empty events array', async () => {
      const result = await verifyEventLog({ events: [] });

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => e.includes('empty events array'))).toBe(true);
    });

    test('handles verifier that throws error', async () => {
      const throwingVerifier = async (): Promise<boolean> => {
        throw new Error('Verification service unavailable');
      };

      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod,
            proofPurpose: 'assertionMethod',
            proofValue: 'zValidBase58Signature',
          }],
        }],
      };

      const result = await verifyEventLog(log, { verifier: throwingVerifier });

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => e.includes('Verification service unavailable'))).toBe(true);
    });
  });

  describe('multiple proofs per event', () => {
    test('verifies event with multiple valid proofs', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: new Date().toISOString(),
              verificationMethod,
              proofPurpose: 'assertionMethod',
              proofValue: 'zControllerSignature',
            },
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: new Date().toISOString(),
              verificationMethod: 'did:web:witness.example.com#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zWitnessSignature',
            },
          ],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      expect(result.events[0].proofValid).toBe(true);
    });

    test('returns verified: false if any proof in event is invalid', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: new Date().toISOString(),
              verificationMethod,
              proofPurpose: 'assertionMethod',
              proofValue: 'zValidSignature',
            },
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: new Date().toISOString(),
              verificationMethod: '', // Invalid - empty
              proofPurpose: 'assertionMethod',
              proofValue: 'zAnotherSignature',
            },
          ],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
      expect(result.events[0].proofValid).toBe(false);
    });
  });

  describe('VerificationResult structure', () => {
    test('returns correct VerificationResult structure for valid log', async () => {
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog({ name: 'Test' }, options);
      const result = await verifyEventLog(log);

      expect(result).toHaveProperty('verified');
      expect(result).toHaveProperty('errors');
      expect(result).toHaveProperty('events');
      expect(typeof result.verified).toBe('boolean');
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.events)).toBe(true);
    });

    test('EventVerification has correct structure', async () => {
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog({ name: 'Test' }, options);
      const result = await verifyEventLog(log);

      const eventVerification = result.events[0];
      expect(eventVerification).toHaveProperty('index');
      expect(eventVerification).toHaveProperty('type');
      expect(eventVerification).toHaveProperty('proofValid');
      expect(eventVerification).toHaveProperty('chainValid');
      expect(eventVerification).toHaveProperty('errors');
      
      expect(typeof eventVerification.index).toBe('number');
      expect(typeof eventVerification.type).toBe('string');
      expect(typeof eventVerification.proofValid).toBe('boolean');
      expect(typeof eventVerification.chainValid).toBe('boolean');
      expect(Array.isArray(eventVerification.errors)).toBe(true);
    });
  });

  describe('custom verifier', () => {
    test('uses custom verifier when provided', async () => {
      let verifierCalled = false;
      const customVerifier = async (proof: DataIntegrityProof, data: unknown): Promise<boolean> => {
        verifierCalled = true;
        return true;
      };

      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog({ name: 'Test' }, options);
      await verifyEventLog(log, { verifier: customVerifier });

      expect(verifierCalled).toBe(true);
    });

    test('passes correct data to custom verifier', async () => {
      let receivedProof: DataIntegrityProof | null = null;
      let receivedData: unknown = null;

      const customVerifier = async (proof: DataIntegrityProof, data: unknown): Promise<boolean> => {
        receivedProof = proof;
        receivedData = data;
        return true;
      };

      const eventData = { name: 'Test', metadata: { key: 'value' } };
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      const log = await createEventLog(eventData, options);
      await verifyEventLog(log, { verifier: customVerifier });

      expect(receivedProof).not.toBeNull();
      expect(receivedProof?.cryptosuite).toBe('eddsa-jcs-2022');
      expect(receivedData).not.toBeNull();
      expect((receivedData as any).type).toBe('create');
      expect((receivedData as any).data).toEqual(eventData);
    });
  });
});
