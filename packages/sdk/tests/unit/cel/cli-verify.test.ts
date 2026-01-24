/**
 * CLI Verify Command Tests
 * 
 * Tests for the verify command implementation (US-021)
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

// Mock signer that creates valid proofs
function createMockSigner(verificationMethod: string = 'did:key:z6MkTest#key-1') {
  return async (data: unknown): Promise<DataIntegrityProof> => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod,
    proofPurpose: 'assertionMethod',
    proofValue: 'z3ABC123mockProofValue',
  });
}

// Mock signer that creates witness proofs
function createMockWitnessSigner(witnessedAt: string): (data: unknown) => Promise<WitnessProof> {
  return async (data: unknown): Promise<WitnessProof> => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod: 'did:key:z6MkWitness#key-1',
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
      // Create a valid event log
      const signer = createMockSigner();
      const log = await createEventLog({ name: 'Test Asset' }, {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
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
      // Create a log with multiple events
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
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
      // Create a valid log
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
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
            verificationMethod: 'did:key:z6MkTest#key-1',
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
            verificationMethod: 'did:key:z6MkTest#key-1',
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
      // Create a valid event log
      const signer = createMockSigner();
      const log = await createEventLog({ name: 'CBOR Test Asset' }, {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
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
    it('shows witness proofs in output', async () => {
      // Create a log with witness proof
      const controllerSigner = createMockSigner();
      const log = await createEventLog({ name: 'Witnessed Asset' }, {
        signer: controllerSigner,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      });
      
      // Add a witness proof to the event
      const witnessedAt = '2026-01-20T12:00:00Z';
      const witnessProof: WitnessProof = {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: 'did:key:z6MkWitness#key-1',
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
      
      // Verify
      const result = await verifyCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.result?.events[0].proofValid).toBe(true);
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
      const signer = createMockSigner();
      const log = await createEventLog({ name: 'Test' }, {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
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
