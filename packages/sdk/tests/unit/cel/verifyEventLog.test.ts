import { describe, test, expect, beforeAll } from 'bun:test';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import type {
  EventLog,
  LogEntry,
  DataIntegrityProof,
  CreateOptions,
  VerifyOptions,
} from '../../../src/cel/types';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';

/**
 * Mock signer that creates a structurally valid DataIntegrityProof.
 * Uses a non-did:key verificationMethod — proofs from this signer fail closed
 * (no resolver).  Use only in tests that:
 *   (a) supply a custom verifier, or
 *   (b) expect verified: false (testing chain/structure failures).
 */
function createMockSigner(verificationMethod: string) {
  return async (_data: unknown): Promise<DataIntegrityProof> => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod,
    proofPurpose: 'assertionMethod',
    proofValue: 'z' + 'a'.repeat(86),
  });
}

/**
 * Builds a real Ed25519 did:key signer.  The public key is embedded in the
 * DID identifier, so `verifyEventLog` can verify the signature offline without
 * any DID resolver.
 */
async function makeRealSigner(): Promise<{
  signer: (data: unknown) => Promise<DataIntegrityProof>;
  verificationMethod: string;
}> {
  const ed25519 = await import('@noble/ed25519');
  const privateKeyBytes = ed25519.utils.randomPrivateKey();
  const publicKeyBytes = new Uint8Array(
    await (ed25519 as any).getPublicKeyAsync(privateKeyBytes),
  );
  const pub = multikey.encodePublicKey(publicKeyBytes, 'Ed25519');
  const verificationMethod = `did:key:${pub}#${pub}`;

  const signer = async (data: unknown): Promise<DataIntegrityProof> => {
    const sig = await (ed25519 as any).signAsync(canonicalizeEvent(data), privateKeyBytes);
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue: multikey.encodeMultibase(new Uint8Array(sig)),
    };
  };

  return { signer, verificationMethod };
}

describe('verifyEventLog', () => {
  // A non-did:key VM used in tests that expect verified: false or supply a
  // custom verifier.  Proofs with this VM fail closed (no resolver in unit tests).
  const structuralVm = 'did:web:example.com#key-1';
  // Legacy alias used in a few test-data literals below.
  const verificationMethod = structuralVm;

  describe('basic verification', () => {
    test('verifies a valid event log with single create event', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const options: CreateOptions = { signer, verificationMethod: vm };

      const log = await createEventLog({ name: 'Test Asset' }, options);
      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.events).toHaveLength(1);
    });

    test('verifies a valid event log with multiple events', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const options: CreateOptions = { signer, verificationMethod: vm };

      let log = await createEventLog({ name: 'Test Asset' }, options);
      log = await updateEventLog(log, { name: 'Updated Asset' }, options);
      log = await updateEventLog(log, { name: 'Final Asset' }, options);

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.events).toHaveLength(3);
    });

    test('returns per-event verification details', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const options: CreateOptions = { signer, verificationMethod: vm };

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
    test('returns verified: true when proof structure is valid and key resolves', async () => {
      // Uses a real did:key signer — verifiable offline without a resolver.
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const options: CreateOptions = { signer, verificationMethod: vm };
      const log = await createEventLog({ name: 'Test' }, options);

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

    test('rejects eddsa-rdfc-2022 cryptosuite (CEL only supports eddsa-jcs-2022)', async () => {
      // CEL uses Ed25519-over-JCS; eddsa-rdfc-2022 cannot be verified here — fail closed.
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

      expect(result.verified).toBe(false);
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
    test('verifies event with multiple valid proofs (all did:key, resolved offline)', async () => {
      // Both proofs must pass; use real did:key signers for both controller and witness.
      const { signer: s1, verificationMethod: vm1 } = await makeRealSigner();
      const { signer: s2, verificationMethod: vm2 } = await makeRealSigner();

      // Build the event data manually — two proofs sign the same canonical payload.
      const eventData = { name: 'Test' };
      const proof1 = await s1({ type: 'create', data: eventData });
      const proof2 = await s2({ type: 'create', data: eventData });

      const log: EventLog = {
        events: [{
          type: 'create',
          data: eventData,
          proof: [proof1, proof2],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      expect(result.events[0].proofValid).toBe(true);
    });

    test('verifies event with one valid and one non-did:key proof (second fails closed)', async () => {
      // Without a resolver, the did:web proof fails closed.
      const { signer: s1, verificationMethod: vm1 } = await makeRealSigner();
      const eventData = { name: 'Test' };
      const proof1 = await s1({ type: 'create', data: eventData });

      const log: EventLog = {
        events: [{
          type: 'create',
          data: eventData,
          proof: [
            proof1,
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

      // No resolver — second proof fails closed → overall proofValid: false.
      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
      expect(result.events[0].proofValid).toBe(false);
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

  describe('hash chain verification', () => {
    test('returns verified: true for valid hash chain', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const options: CreateOptions = { signer, verificationMethod: vm };

      let log = await createEventLog({ name: 'Test Asset' }, options);
      log = await updateEventLog(log, { name: 'Updated Asset' }, options);
      log = await updateEventLog(log, { name: 'Final Asset' }, options);

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      expect(result.events.every(e => e.chainValid)).toBe(true);
    });

    test('returns verified: false when first event has previousEvent', async () => {
      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          previousEvent: 'uShouldNotExistOnFirstEvent',
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

      expect(result.verified).toBe(false);
      expect(result.events[0].chainValid).toBe(false);
      expect(result.errors.some(e => e.includes('First event must not have previousEvent'))).toBe(true);
    });

    test('returns verified: false when second event is missing previousEvent', async () => {
      const log: EventLog = {
        events: [
          {
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
          },
          {
            type: 'update',
            data: { name: 'Updated' },
            // Missing previousEvent!
            proof: [{
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: new Date().toISOString(),
              verificationMethod,
              proofPurpose: 'assertionMethod',
              proofValue: 'zAnotherSignature',
            }],
          },
        ],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
      expect(result.events[0].chainValid).toBe(true);
      expect(result.events[1].chainValid).toBe(false);
      expect(result.errors.some(e => e.includes('Missing previousEvent reference'))).toBe(true);
    });

    test('returns verified: false when hash chain is broken', async () => {
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      // Create a valid log first
      let log = await createEventLog({ name: 'Test Asset' }, options);
      log = await updateEventLog(log, { name: 'Updated Asset' }, options);

      // Tamper with the previousEvent hash
      const tamperedLog: EventLog = {
        events: [
          log.events[0],
          {
            ...log.events[1],
            previousEvent: 'uTamperedHashThatDoesNotMatch',
          },
        ],
      };

      const result = await verifyEventLog(tamperedLog);

      expect(result.verified).toBe(false);
      expect(result.events[1].chainValid).toBe(false);
      expect(result.errors.some(e => e.includes('Hash chain broken'))).toBe(true);
    });

    test('returns verified: false with specific error for broken chain', async () => {
      const options: CreateOptions = {
        signer: createMockSigner(verificationMethod),
        verificationMethod,
      };

      let log = await createEventLog({ name: 'Test' }, options);
      log = await updateEventLog(log, { version: 2 }, options);
      log = await updateEventLog(log, { version: 3 }, options);

      // Tamper with the middle event's previousEvent
      const tamperedLog: EventLog = {
        events: [
          log.events[0],
          {
            ...log.events[1],
            previousEvent: 'uWrongHash123',
          },
          log.events[2],
        ],
      };

      const result = await verifyEventLog(tamperedLog);

      expect(result.verified).toBe(false);
      // Should fail on event 1 (second event)
      expect(result.events[1].chainValid).toBe(false);
      // Event 2 (third event) also fails because event 1 was tampered
      expect(result.events[2].chainValid).toBe(false);
      
      // Check for specific error message
      const brokenChainErrors = result.errors.filter(e => e.includes('Hash chain broken'));
      expect(brokenChainErrors.length).toBeGreaterThan(0);
    });

    test('chainValid is true for each event in valid chain', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const options: CreateOptions = { signer, verificationMethod: vm };

      let log = await createEventLog({ name: 'Asset' }, options);
      log = await updateEventLog(log, { v: 2 }, options);
      log = await updateEventLog(log, { v: 3 }, options);
      log = await updateEventLog(log, { v: 4 }, options);

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      expect(result.events).toHaveLength(4);
      result.events.forEach((ev, i) => {
        expect(ev.chainValid).toBe(true);
        expect(ev.index).toBe(i);
      });
    });

    test('valid chain passes with single create event', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const options: CreateOptions = { signer, verificationMethod: vm };

      const log = await createEventLog({ name: 'Single Event' }, options);
      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      expect(result.events[0].chainValid).toBe(true);
    });
  });
});
