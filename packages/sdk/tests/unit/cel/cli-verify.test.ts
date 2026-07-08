/**
 * CLI Verify Command Tests
 *
 * Tests for the verify command implementation (US-021)
 *
 * After the fail-closed change (plan 020), non-did:key proofs fail unless a
 * DIDManager-backed resolver can fetch the key.  The CLI builds a live resolver
 * from OriginalsSDK, which will return null for fake DIDs in unit tests.
 * Therefore, all tests that expect `verified: true` must use real Ed25519
 * did:key signers whose keys are embedded in the identifier.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { verifyCommand, VerifyFlags } from '../../../src/cel/cli/verify';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import { serializeEventLogJson } from '../../../src/cel/serialization/json';
import { serializeEventLogCbor } from '../../../src/cel/serialization/cbor';
import type { DataIntegrityProof, WitnessProof, EventLog } from '../../../src/cel/types';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';

/**
 * Creates a real Ed25519 did:key signer — identical to the approach in
 * proof-verification.test.ts. These proofs are verified offline without a
 * network resolver because the key is embedded in the did:key identifier.
 */
async function createRealDidKeySigner(): Promise<{
  signer: (data: unknown) => Promise<DataIntegrityProof>;
  verificationMethod: string;
}> {
  const ed25519 = await import('@noble/ed25519');
  const privateKeyBytes = ed25519.utils.randomSecretKey();
  const publicKeyBytes = new Uint8Array(
    await (ed25519 as any).getPublicKeyAsync(privateKeyBytes),
  );
  const publicKeyMultikey = multikey.encodePublicKey(publicKeyBytes, 'Ed25519');
  const verificationMethod = `did:key:${publicKeyMultikey}#${publicKeyMultikey}`;

  const signer = async (data: unknown): Promise<DataIntegrityProof> => {
    const dataBytes = canonicalizeEvent(data);
    const signature = await (ed25519 as any).signAsync(dataBytes, privateKeyBytes);
    const proofValue = multikey.encodeMultibase(new Uint8Array(signature));
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue,
    };
  };

  return { signer, verificationMethod };
}

// Mock signer that creates witness proofs (did:web — will fail crypto check but
// structural errors in chain / proof-structure tests still work as intended)
function createMockWitnessSigner(witnessedAt: string): (data: unknown) => Promise<WitnessProof> {
  return async (_data: unknown): Promise<WitnessProof> => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod: 'did:web:witness.example.com#key-1',
    proofPurpose: 'assertionMethod',
    proofValue: 'z3WitnessProof123',
    witnessedAt,
  });
}

describe('CLI Verify Command', () => {
  let tempDir: string;
  
  beforeEach(() => {
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cel-verify-test-'));
  });
  
  afterEach(() => {
    // Clean up temp files
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });
  
  describe('argument validation', () => {
    it('returns error when --log is missing', async () => {
      const result = await verifyCommand({});
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('--log is required');
    });
    
    it('returns error when log file does not exist', async () => {
      const result = await verifyCommand({ log: '/nonexistent/file.json' });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('File not found');
    });
    
    it('handles help flag', async () => {
      const result = await verifyCommand({ help: true });
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });
    
    it('handles -h flag', async () => {
      const result = await verifyCommand({ h: true });
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });
  });
  
  describe('JSON format verification', () => {
    it('verifies a valid single-event log', async () => {
      // Create a valid event log using a real did:key signer (verified offline).
      const { signer, verificationMethod } = await createRealDidKeySigner();
      const log = await createEventLog({ name: 'Test Asset' }, {
        signer,
        verificationMethod,
        proofPurpose: 'assertionMethod',
      });

      // Save to file
      const filePath = path.join(tempDir, 'test.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      // Verify
      const result = await verifyCommand({ log: filePath });

      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.result?.verified).toBe(true);
      expect(result.result?.events.length).toBe(1);
    });

    it('verifies a valid multi-event log with hash chain', async () => {
      // Create a log with multiple events using a real did:key signer.
      const { signer, verificationMethod } = await createRealDidKeySigner();
      const options = {
        signer,
        verificationMethod,
        proofPurpose: 'assertionMethod',
      };

      let log = await createEventLog({ name: 'Test Asset' }, options);
      log = await updateEventLog(log, { description: 'Updated' }, options);
      log = await updateEventLog(log, { version: 2 }, options);

      // Save to file
      const filePath = path.join(tempDir, 'multi-event.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      // Verify
      const result = await verifyCommand({ log: filePath });

      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.result?.events.length).toBe(3);

      // All events should pass
      for (const event of result.result!.events) {
        expect(event.proofValid).toBe(true);
        expect(event.chainValid).toBe(true);
      }
    });

    it('returns verified: false for broken hash chain', async () => {
      // Create a valid log using a real did:key signer.
      const { signer, verificationMethod } = await createRealDidKeySigner();
      const options = {
        signer,
        verificationMethod,
        proofPurpose: 'assertionMethod',
      };

      let log = await createEventLog({ name: 'Test Asset' }, options);
      log = await updateEventLog(log, { description: 'Updated' }, options);
      
      // Tamper with the hash chain
      const tampered: EventLog = {
        ...log,
        events: [
          log.events[0],
          { ...log.events[1], previousEvent: 'uTampered_Invalid_Hash' },
        ],
      };
      
      // Save to file
      const filePath = path.join(tempDir, 'broken-chain.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(tampered));
      
      // Verify
      const result = await verifyCommand({ log: filePath });
      
      expect(result.success).toBe(true); // Command ran successfully
      expect(result.verified).toBe(false); // But verification failed
      expect(result.result?.verified).toBe(false);
      expect(result.result?.events[1].chainValid).toBe(false);
    });
    
    it('returns verified: false for invalid proof', async () => {
      // Create a log with invalid proof
      const invalidLog: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: 'did:web:example.com#key-1',
            proofPurpose: 'assertionMethod',
            proofValue: 'invalid_no_multibase_prefix', // Invalid - no z or u prefix
          }],
        }],
      };
      
      // Save to file
      const filePath = path.join(tempDir, 'invalid-proof.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(invalidLog));
      
      // Verify
      const result = await verifyCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.verified).toBe(false);
      expect(result.result?.events[0].proofValid).toBe(false);
    });
    
    it('returns verified: false for first event with previousEvent', async () => {
      // Create a log where first event incorrectly has previousEvent
      const invalidLog: EventLog = {
        events: [{
          type: 'create',
          data: { name: 'Test' },
          previousEvent: 'uShouldNotBeHere123', // Invalid for first event
          proof: [{
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: new Date().toISOString(),
            verificationMethod: 'did:web:example.com#key-1',
            proofPurpose: 'assertionMethod',
            proofValue: 'z3ABC123mockProofValue',
          }],
        }],
      };
      
      // Save to file
      const filePath = path.join(tempDir, 'invalid-first-event.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(invalidLog));
      
      // Verify
      const result = await verifyCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.verified).toBe(false);
      expect(result.result?.events[0].chainValid).toBe(false);
      expect(result.result?.errors.some(e => e.includes('First event must not have previousEvent'))).toBe(true);
    });
  });
  
  describe('CBOR format verification', () => {
    it('verifies a valid CBOR event log', async () => {
      // Use a real did:key signer so offline crypto verification passes.
      const { signer, verificationMethod } = await createRealDidKeySigner();
      const log = await createEventLog({ name: 'CBOR Test Asset' }, {
        signer,
        verificationMethod,
        proofPurpose: 'assertionMethod',
      });

      // Save as CBOR
      const filePath = path.join(tempDir, 'test.cel.cbor');
      fs.writeFileSync(filePath, serializeEventLogCbor(log));

      // Verify
      const result = await verifyCommand({ log: filePath });

      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
    });
  });

  describe('witness attestations', () => {
    it('witness non-gating: controller valid + unresolvable witness → verified: true, witness reported unverified', async () => {
      // Controller proof uses a real did:key signer — verifies offline.
      const { signer: controllerSigner, verificationMethod } = await createRealDidKeySigner();
      const log = await createEventLog({ name: 'Witnessed Asset' }, {
        signer: controllerSigner,
        verificationMethod,
        proofPurpose: 'assertionMethod',
      });

      // Add a witness proof (did:web — will fail closed; no live resolver in tests).
      const witnessedAt = '2026-01-20T12:00:00Z';
      const witnessProof: WitnessProof = {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: 'did:web:witness.example.com#key-1',
        proofPurpose: 'assertionMethod',
        proofValue: 'z3WitnessProof123',
        witnessedAt,
      };

      const witnessedLog: EventLog = {
        events: [{
          ...log.events[0],
          proof: [...log.events[0].proof, witnessProof],
        }],
      };

      // Save to file
      const filePath = path.join(tempDir, 'witnessed.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(witnessedLog));

      // Verify — the controller proof (did:key) verifies offline, so the log is
      // verified: true.  The witness proof (did:web) fails closed because the CLI's
      // DIDManager can't resolve the fake witness DID, but this is NON-GATING.
      const result = await verifyCommand({ log: filePath });

      expect(result.success).toBe(true);
      // Controller proof passes — witness failure is non-gating.
      expect(result.verified).toBe(true);
      // Chain is valid.
      expect(result.result?.events[0].chainValid).toBe(true);
      // The witness proof is reported but marked unverified.
      expect(result.result?.events[0].witnessProofs).toBeDefined();
      expect(result.result?.events[0].witnessProofs).toHaveLength(1);
      expect(result.result?.events[0].witnessProofs![0].verificationMethod).toBe('did:web:witness.example.com#key-1');
      expect(result.result?.events[0].witnessProofs![0].verified).toBe(false);
    });
  });
  
  describe('controller-key TOFU authorization', () => {
    it('returns verified: false when a later event is signed by a key not authorized by the create event', async () => {
      // Event 0 establishes the trust-on-first-use controller key (signer A).
      // A subsequent event signed by a *different* did:key (signer B) is
      // cryptographically valid on its own, but is not authorized by the log's
      // create event, so the CLI must fail closed.
      const signerA = await createRealDidKeySigner();
      const signerB = await createRealDidKeySigner();
      expect(signerA.verificationMethod).not.toBe(signerB.verificationMethod);

      let log = await createEventLog({ name: 'TOFU Asset' }, {
        signer: signerA.signer,
        verificationMethod: signerA.verificationMethod,
        proofPurpose: 'assertionMethod',
      });
      log = await updateEventLog(log, { description: 'Rogue update' }, {
        signer: signerB.signer,
        verificationMethod: signerB.verificationMethod,
        proofPurpose: 'assertionMethod',
      });

      const filePath = path.join(tempDir, 'tofu-unauthorized.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      const result = await verifyCommand({ log: filePath });

      expect(result.success).toBe(true);
      expect(result.verified).toBe(false);
      // The second event's controller proof is rejected as unauthorized.
      expect(result.result?.events[1]?.proofValid).toBe(false);
      expect(
        result.result?.errors?.some((e) =>
          e.includes("is not authorized by the log's create event")
        )
      ).toBe(true);
    });

    it('returns verified: true when every event is signed by the create-event controller key', async () => {
      // Control case: the same signer authorizes every event, so TOFU passes.
      const signer = await createRealDidKeySigner();
      const options = {
        signer: signer.signer,
        verificationMethod: signer.verificationMethod,
        proofPurpose: 'assertionMethod',
      };

      let log = await createEventLog({ name: 'TOFU Asset' }, options);
      log = await updateEventLog(log, { description: 'Authorized update' }, options);

      const filePath = path.join(tempDir, 'tofu-authorized.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      const result = await verifyCommand({ log: filePath });

      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
    });
  });

  describe('btco-anchor gating', () => {
    it('fails closed on a bitcoin-ordinals witness proof because the CLI wires no ordinalsProvider', async () => {
      // A `bitcoin-ordinals-2024` witness proof defines a btco log's resolvable
      // on-chain identity, so it GATES the result. The CLI does not supply an
      // ordinalsProvider, so the anchor cannot be confirmed and verification
      // must fail closed rather than trusting attacker-editable satoshi fields.
      const { signer, verificationMethod } = await createRealDidKeySigner();
      const log = await createEventLog({ name: 'Anchored Asset' }, {
        signer,
        verificationMethod,
        proofPurpose: 'assertionMethod',
      });

      const bitcoinWitnessProof = {
        type: 'DataIntegrityProof',
        cryptosuite: 'bitcoin-ordinals-2024',
        created: new Date().toISOString(),
        verificationMethod: 'did:btco:1066296127976657#0',
        proofPurpose: 'assertionMethod',
        proofValue: 'zBitcoinAnchorProof',
        witnessedAt: '2026-01-20T12:00:00Z',
        satoshi: '1066296127976657',
        inscriptionId: 'abc123i0',
        txid: 'abc123',
      } as unknown as WitnessProof;

      const anchoredLog: EventLog = {
        events: [{
          ...log.events[0],
          proof: [...log.events[0].proof, bitcoinWitnessProof],
        }],
      };

      const filePath = path.join(tempDir, 'btco-anchored.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(anchoredLog));

      const result = await verifyCommand({ log: filePath });

      expect(result.success).toBe(true);
      // Bitcoin-anchor failure gates the result — unlike ordinary witnesses.
      expect(result.verified).toBe(false);
      expect(
        result.result?.errors?.some((e) =>
          e.includes('cannot be verified without an ordinalsProvider')
        )
      ).toBe(true);
    });
  });

  describe('error handling', () => {
    it('handles invalid JSON gracefully', async () => {
      const filePath = path.join(tempDir, 'invalid.cel.json');
      fs.writeFileSync(filePath, 'not valid json {{{');
      
      const result = await verifyCommand({ log: filePath });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to load event log');
    });
    
    it('handles malformed event log structure', async () => {
      const filePath = path.join(tempDir, 'malformed.cel.json');
      fs.writeFileSync(filePath, JSON.stringify({ notEvents: [] }));
      
      const result = await verifyCommand({ log: filePath });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to load event log');
    });
    
    it('handles empty events array', async () => {
      const filePath = path.join(tempDir, 'empty.cel.json');
      fs.writeFileSync(filePath, JSON.stringify({ events: [] }));
      
      const result = await verifyCommand({ log: filePath });
      
      expect(result.success).toBe(true); // Command succeeded
      expect(result.verified).toBe(false); // But verification failed
      expect(result.result?.errors).toContain('Invalid event log: empty events array');
    });
  });
  
  describe('VerifyResult structure', () => {
    it('includes detailed verification result', async () => {
      const { signer, verificationMethod } = await createRealDidKeySigner();
      const log = await createEventLog({ name: 'Test' }, {
        signer,
        verificationMethod,
        proofPurpose: 'assertionMethod',
      });

      const filePath = path.join(tempDir, 'detail.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      const result = await verifyCommand({ log: filePath });

      expect(result.result).toBeDefined();
      expect(result.result?.verified).toBe(true);
      expect(result.result?.events).toBeInstanceOf(Array);
      expect(result.result?.events[0]).toHaveProperty('index');
      expect(result.result?.events[0]).toHaveProperty('type');
      expect(result.result?.events[0]).toHaveProperty('proofValid');
      expect(result.result?.events[0]).toHaveProperty('chainValid');
      expect(result.result?.events[0]).toHaveProperty('errors');
    });
  });
});
