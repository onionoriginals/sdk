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
import { canonicalizeEvent, canonicalizeEntryForChain, witnessSigningBytes } from '../../../src/cel/canonicalize';
import { computeDigestMultibase, decodeDigestMultibase } from '../../../src/cel/hash';

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
  const privateKeyBytes = ed25519.utils.randomSecretKey();
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
    test('rejects a create event carrying more than one controller proof (ambiguous authority)', async () => {
      // The create event's proof array is not signed, so a second controller
      // proof cannot be trusted to establish authority — it is exactly how an
      // attacker would inject a co-signer. Such a create event is rejected even
      // when both proofs are individually valid.
      const { signer: s1 } = await makeRealSigner();
      const { signer: s2 } = await makeRealSigner();

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

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => /exactly one controller proof/.test(e))).toBe(true);
    });

    test('fails with a distinct authority error when the create key is unresolvable', async () => {
      // A non-did:key create proof whose resolver returns null (e.g. a transient
      // resolver failure) must produce a clear authority error, not silently
      // leave the authorized set empty and reject every event as "not authorized".
      const eventData = { name: 'Test' };
      const log: EventLog = {
        events: [{
          type: 'create',
          data: eventData,
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: '2020-01-01T00:00:00Z',
            verificationMethod: 'did:webvh:example.com:alice#key-0',
            proofPurpose: 'assertionMethod',
            proofValue: 'zSomeSignature',
          }],
        }],
      };

      const result = await verifyEventLog(log, { resolveKey: async () => null });

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => /could not be .*resolved to establish authority/.test(e))).toBe(true);
    });

    test('rejects a create event with a non-array proof without crashing', async () => {
      // A truthy-but-non-array proof (e.g. a bare object) must yield a
      // structured failure, not a TypeError from calling .filter on it.
      const log = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: { type: 'DataIntegrityProof', proofValue: 'z...' },
        }],
      } as unknown as EventLog;

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => /exactly one controller proof/.test(e))).toBe(true);
    });

    test('a custom verifier bypasses the single-controller-proof authority check', async () => {
      // With a custom verifier, the caller owns proof semantics/authorization,
      // so a legitimately multi-proof create event must not be rejected by the
      // default authority check before the verifier runs.
      const { signer: s1 } = await makeRealSigner();
      const { signer: s2 } = await makeRealSigner();
      const eventData = { name: 'Test' };
      const proof1 = await s1({ type: 'create', data: eventData });
      const proof2 = await s2({ type: 'create', data: eventData });

      const log: EventLog = {
        events: [{ type: 'create', data: eventData, proof: [proof1, proof2] }],
      };

      const result = await verifyEventLog(log, { verifier: async () => true });

      expect(result.verified).toBe(true);
      expect(result.errors.some(e => /exactly one controller proof/.test(e))).toBe(false);
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

  describe('witness proof non-gating', () => {
    test('controller (did:key) + unresolvable witness → verified: true, witnessProofs[0].verified: false', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const eventData = { name: 'Witnessed Asset' };
      const controllerProof = await signer({ type: 'create', data: eventData });

      // Witness proof with witnessedAt — cannot be resolved (no resolver, did:web VM).
      const witnessProof = {
        type: 'DataIntegrityProof' as const,
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: 'did:web:witness.example.com#key-1',
        proofPurpose: 'assertionMethod',
        proofValue: 'z3WitnessProof123',
        witnessedAt: '2026-01-20T12:00:00Z',
      };

      const log: EventLog = {
        events: [{
          type: 'create',
          data: eventData,
          proof: [controllerProof, witnessProof],
        }],
      };

      // No resolveKey provided — witness fails closed, but it is NON-GATING.
      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      expect(result.events[0].proofValid).toBe(true);
      expect(result.events[0].witnessProofs).toBeDefined();
      expect(result.events[0].witnessProofs).toHaveLength(1);
      expect(result.events[0].witnessProofs![0].verificationMethod).toBe('did:web:witness.example.com#key-1');
      expect(result.events[0].witnessProofs![0].verified).toBe(false);
    });

    test('controller (did:key) + resolvable correctly-signed witness → verified: true, witnessProofs[0].verified: true', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const eventData = { name: 'Well-Witnessed Asset' };
      const controllerProof = await signer({ type: 'create', data: eventData });

      // Generate a real Ed25519 keypair for the witness.
      const ed25519 = await import('@noble/ed25519');
      const witnessPrivateKey = ed25519.utils.randomSecretKey();
      const witnessPublicKey = new Uint8Array(
        await (ed25519 as any).getPublicKeyAsync(witnessPrivateKey),
      );
      const witnessVm = 'did:webvh:witness.example.com#key-ed25519';

      // Witnesses attest to the event DIGEST — witnessEvent hands
      // witness.witness(digestMultibase) only the digest string, so that is
      // what an honest witness signs (issue #240; verification previously
      // checked the signature against the event object and could never pass
      // for a real witness).
      const digest = computeDigestMultibase(canonicalizeEntryForChain({
        type: 'create',
        data: eventData,
        proof: []
      } as any));
      const dataBytes = canonicalizeEvent(digest);
      const witnessSig = await (ed25519 as any).signAsync(dataBytes, witnessPrivateKey);
      const witnessProofValue = multikey.encodeMultibase(new Uint8Array(witnessSig));

      const witnessProof = {
        type: 'DataIntegrityProof' as const,
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: witnessVm,
        proofPurpose: 'assertionMethod',
        proofValue: witnessProofValue,
        witnessedAt: '2026-01-20T12:00:00Z',
      };

      const log: EventLog = {
        events: [{
          type: 'create',
          data: eventData,
          proof: [controllerProof, witnessProof],
        }],
      };

      // Resolver returns the witness public key when asked.
      const resolveKey = async (method: string): Promise<Uint8Array | null> => {
        if (method === witnessVm) return witnessPublicKey;
        return null;
      };

      const result = await verifyEventLog(log, { resolveKey });

      expect(result.verified).toBe(true);
      expect(result.events[0].proofValid).toBe(true);
      expect(result.events[0].witnessProofs).toBeDefined();
      expect(result.events[0].witnessProofs).toHaveLength(1);
      expect(result.events[0].witnessProofs![0].verificationMethod).toBe(witnessVm);
      expect(result.events[0].witnessProofs![0].verified).toBe(true);
    });

    test('witnessSigningBytes(digest) produces the exact preimage verifyEventLog accepts (#314)', async () => {
      const { signer } = await makeRealSigner();
      const eventData = { name: 'Helper-Signed Asset' };
      const controllerProof = await signer({ type: 'create', data: eventData });

      const ed25519 = await import('@noble/ed25519');
      const witnessPrivateKey = ed25519.utils.randomSecretKey();
      const witnessPublicKey = new Uint8Array(
        await (ed25519 as any).getPublicKeyAsync(witnessPrivateKey),
      );
      const witnessVm = 'did:webvh:witness.example.com#key-ed25519';

      const digest = computeDigestMultibase(canonicalizeEntryForChain({
        type: 'create',
        data: eventData,
        proof: [],
      } as any));

      // Sign the bytes the public helper hands out — no knowledge of the
      // internal canonicalizeEvent(<string>) quoting convention required.
      const message = witnessSigningBytes(digest);
      // The helper must return exactly what the verifier reconstructs.
      expect(Array.from(message)).toEqual(Array.from(canonicalizeEvent(digest)));
      const witnessSig = await (ed25519 as any).signAsync(message, witnessPrivateKey);

      const log: EventLog = {
        events: [{
          type: 'create',
          data: eventData,
          proof: [controllerProof, {
            type: 'DataIntegrityProof' as const,
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: witnessVm,
            proofPurpose: 'assertionMethod',
            proofValue: multikey.encodeMultibase(new Uint8Array(witnessSig)),
            witnessedAt: '2026-01-20T12:00:00Z',
          }],
        }],
      };

      const resolveKey = async (method: string): Promise<Uint8Array | null> =>
        method === witnessVm ? witnessPublicKey : null;

      const result = await verifyEventLog(log, { resolveKey });
      expect(result.events[0].witnessProofs![0].verified).toBe(true);
    });

    test('signing the RAW decoded digest bytes (the wrong preimage) fails witness verification (#314)', async () => {
      const { signer } = await makeRealSigner();
      const eventData = { name: 'Wrong-Preimage Asset' };
      const controllerProof = await signer({ type: 'create', data: eventData });

      const ed25519 = await import('@noble/ed25519');
      const witnessPrivateKey = ed25519.utils.randomSecretKey();
      const witnessPublicKey = new Uint8Array(
        await (ed25519 as any).getPublicKeyAsync(witnessPrivateKey),
      );
      const witnessVm = 'did:webvh:witness.example.com#key-ed25519';

      const digest = computeDigestMultibase(canonicalizeEntryForChain({
        type: 'create',
        data: eventData,
        proof: [],
      } as any));

      // The classic third-party mistake: sign the raw hash bytes rather than
      // the JSON-quoted digest string the SDK actually verifies against.
      const wrongMessage = decodeDigestMultibase(digest);
      expect(Array.from(wrongMessage)).not.toEqual(Array.from(witnessSigningBytes(digest)));
      const witnessSig = await (ed25519 as any).signAsync(wrongMessage, witnessPrivateKey);

      const log: EventLog = {
        events: [{
          type: 'create',
          data: eventData,
          proof: [controllerProof, {
            type: 'DataIntegrityProof' as const,
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: witnessVm,
            proofPurpose: 'assertionMethod',
            proofValue: multikey.encodeMultibase(new Uint8Array(witnessSig)),
            witnessedAt: '2026-01-20T12:00:00Z',
          }],
        }],
      };

      const resolveKey = async (method: string): Promise<Uint8Array | null> =>
        method === witnessVm ? witnessPublicKey : null;

      const result = await verifyEventLog(log, { resolveKey });
      // Witness proofs are non-gating, so the event still verifies overall,
      // but the witness proof itself must be reported unverified.
      expect(result.events[0].witnessProofs![0].verified).toBe(false);
    });

    test('event with ONLY a witness proof (no controller proof) → verified: false', async () => {
      const witnessOnlyProof = {
        type: 'DataIntegrityProof' as const,
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: 'did:web:witness.example.com#key-1',
        proofPurpose: 'assertionMethod',
        proofValue: 'z3WitnessOnlyProof123',
        witnessedAt: '2026-01-20T12:00:00Z',
      };

      const log: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Witness-Only' },
          proof: [witnessOnlyProof],
        }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
      expect(result.events[0].proofValid).toBe(false);
      expect(result.errors.some(e => e.includes('no controller proof'))).toBe(true);
    });

    test('bad controller proof still fails the log (gating unchanged)', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const eventData = { name: 'Tamper Test' };
      const controllerProof = await signer({ type: 'create', data: eventData });

      // Corrupt the controller proof signature.
      const tamperedControllerProof = {
        ...controllerProof,
        proofValue: 'z' + 'X'.repeat(86),
      };

      const witnessProof = {
        type: 'DataIntegrityProof' as const,
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: 'did:web:witness.example.com#key-1',
        proofPurpose: 'assertionMethod',
        proofValue: 'z3WitnessProof123',
        witnessedAt: '2026-01-20T12:00:00Z',
      };

      const log: EventLog = {
        events: [{
          type: 'create',
          data: eventData,
          proof: [tamperedControllerProof, witnessProof],
        }],
      };

      const result = await verifyEventLog(log);

      // Bad controller proof → log fails even with a witness present.
      expect(result.verified).toBe(false);
      expect(result.events[0].proofValid).toBe(false);
    });

    test('no witnessProofs field when event has no witness proofs', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const log = await createEventLog({ name: 'No Witnesses' }, { signer, verificationMethod: vm });

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      // witnessProofs should be absent when there are no witnesses.
      expect(result.events[0].witnessProofs).toBeUndefined();
    });
  });

  describe('first event must be a create event (issue #295)', () => {
    test('rejects a log whose first (and only) event is a validly-signed update', async () => {
      const { signer } = await makeRealSigner();

      // A single validly-signed `update` event with no `create` — previously
      // this verified even though no state-derivation path can consume it.
      const eventData = { type: 'update' as const, data: { name: 'Orphan Update' } };
      const proof = await signer(eventData);
      const log: EventLog = {
        events: [{ ...eventData, proof: [proof] }],
      };

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => e.includes("first event must be a 'create' event"))).toBe(true);
    });

    test('rejects an update-first log on the custom-verifier path too', async () => {
      const eventData = { type: 'update' as const, data: { name: 'Orphan Update' } };
      const log: EventLog = {
        events: [{
          ...eventData,
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: structuralVm,
            proofPurpose: 'assertionMethod',
            proofValue: 'z' + 'a'.repeat(86),
          }],
        }],
      };

      const result = await verifyEventLog(log, { verifier: async () => true });

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => e.includes("first event must be a 'create' event"))).toBe(true);
    });

    test('still accepts a valid create-first log', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const log = await createEventLog({ name: 'Valid' }, { signer, verificationMethod: vm });

      const result = await verifyEventLog(log);
      expect(result.verified).toBe(true);
    });
  });

  describe('deactivation is terminal (issue #257)', () => {
    async function makeDeactivatedLogWithTrailingUpdate(): Promise<EventLog> {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const { deactivateEventLog } = await import('../../../src/cel/algorithms/deactivateEventLog');
      const { computeDigestMultibase } = await import('../../../src/cel/hash');
      const { canonicalizeEntryForChain } = await import('../../../src/cel/canonicalize');

      let log = await createEventLog({ name: 'Sealed Asset' }, { signer, verificationMethod: vm });
      log = await deactivateEventLog(log, 'retired', { signer, verificationMethod: vm });

      // Craft a validly-signed, correctly-chained update AFTER the deactivate —
      // exactly what deactivateEventLog refuses to append but verification
      // previously accepted.
      const lastEvent = log.events[log.events.length - 1];
      const previousEvent = computeDigestMultibase(canonicalizeEntryForChain(lastEvent));
      const eventData = { type: 'update' as const, data: { name: 'Mutated After Seal' }, previousEvent };
      const proof = await signer(eventData);
      return { ...log, events: [...log.events, { ...eventData, proof: [proof] }] };
    }

    test('create → deactivate → update fails verification even when all signatures are valid', async () => {
      const log = await makeDeactivatedLogWithTrailingUpdate();

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => e.includes('deactivate') && e.includes('sealed'))).toBe(true);
    });

    test('a log ending in a deactivate event still verifies', async () => {
      const { signer, verificationMethod: vm } = await makeRealSigner();
      const { deactivateEventLog } = await import('../../../src/cel/algorithms/deactivateEventLog');

      let log = await createEventLog({ name: 'Retiring Asset' }, { signer, verificationMethod: vm });
      log = await updateEventLog(log, { name: 'Final Form' }, { signer, verificationMethod: vm });
      log = await deactivateEventLog(log, 'retired', { signer, verificationMethod: vm });

      const result = await verifyEventLog(log);

      expect(result.verified).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('events after deactivate fail the log on the custom-verifier path too', async () => {
      const log = await makeDeactivatedLogWithTrailingUpdate();

      const result = await verifyEventLog(log, { verifier: async () => true });

      expect(result.verified).toBe(false);
      expect(result.errors.some(e => e.includes('sealed'))).toBe(true);
    });
  });
});

// ─── Issue #240 — witness proofs verify against the digest they attested ────

describe('issue #240: honest WitnessService attestations verify', () => {
  test('witnessEvent + verifyEventLog round-trip reports the witness proof as verified', async () => {
    const { witnessEvent } = await import('../../../src/cel/algorithms/witnessEvent');
    const ed25519 = await import('@noble/ed25519');

    // Controller creates the log with a real did:key signer
    const { signer } = await makeRealSigner();
    const log = await createEventLog({ name: 'Witnessed Asset' }, { signer });

    // Honest Ed25519 witness: signs exactly the digest string it is handed
    // (the only thing the WitnessService interface ever receives).
    const witnessPrivateKey = ed25519.utils.randomSecretKey();
    const witnessPublicKey = new Uint8Array(await (ed25519 as any).getPublicKeyAsync(witnessPrivateKey));
    const witnessPub = multikey.encodePublicKey(witnessPublicKey, 'Ed25519');
    const witnessVm = `did:key:${witnessPub}#${witnessPub}`;
    const honestWitness = {
      async witness(digestMultibase: string) {
        const sig = await (ed25519 as any).signAsync(canonicalizeEvent(digestMultibase), witnessPrivateKey);
        return {
          type: 'DataIntegrityProof' as const,
          cryptosuite: 'eddsa-jcs-2022',
          created: new Date().toISOString(),
          verificationMethod: witnessVm,
          proofPurpose: 'assertionMethod',
          proofValue: multikey.encodeMultibase(new Uint8Array(sig)),
          witnessedAt: new Date().toISOString(),
        };
      },
    };

    const witnessed = await witnessEvent(log.events[0], honestWitness);
    const witnessedLog = { events: [witnessed] };

    const result = await verifyEventLog(witnessedLog);

    expect(result.verified).toBe(true);
    expect(result.events[0].witnessProofs).toHaveLength(1);
    // Before the fix this was always false: the signature (over the digest)
    // was checked against the event object.
    expect(result.events[0].witnessProofs![0].verified).toBe(true);
  });
});
