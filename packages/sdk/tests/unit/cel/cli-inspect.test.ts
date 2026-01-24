/**
 * CLI Inspect Command Tests
 * 
 * Tests for the inspect command implementation (US-022)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { inspectCommand, InspectFlags } from '../../../src/cel/cli/inspect';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import { deactivateEventLog } from '../../../src/cel/algorithms/deactivateEventLog';
import { serializeEventLogJson } from '../../../src/cel/serialization/json';
import { serializeEventLogCbor } from '../../../src/cel/serialization/cbor';
import type { DataIntegrityProof, WitnessProof, EventLog, ExternalReference } from '../../../src/cel/types';

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

// Create an asset data object similar to what PeerCelManager creates
function createPeerAssetData(name: string, resources: ExternalReference[] = []) {
  return {
    name,
    did: 'did:peer:4z123456789abcdef',
    layer: 'peer' as const,
    resources,
    creator: 'did:peer:4z123456789abcdef',
    createdAt: new Date().toISOString(),
  };
}

describe('CLI Inspect Command', () => {
  let tempDir: string;
  
  beforeEach(() => {
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cel-inspect-test-'));
  });
  
  afterEach(() => {
    // Clean up temp files
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });
  
  describe('argument validation', () => {
    it('returns error when --log is missing', async () => {
      const result = await inspectCommand({});
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('--log is required');
    });
    
    it('returns error when log file does not exist', async () => {
      const result = await inspectCommand({ log: '/nonexistent/file.json' });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('File not found');
    });
    
    it('handles help flag', async () => {
      const result = await inspectCommand({ help: true });
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });
    
    it('handles -h flag', async () => {
      const result = await inspectCommand({ h: true });
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });
  });
  
  describe('event timeline display', () => {
    it('inspects a single create event', async () => {
      const signer = createMockSigner();
      const assetData = createPeerAssetData('Test Asset');
      const log = await createEventLog(assetData, {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      });
      
      const filePath = path.join(tempDir, 'test.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.state).toBeDefined();
      expect(result.state?.name).toBe('Test Asset');
      expect(result.state?.layer).toBe('peer');
      expect(result.state?.deactivated).toBe(false);
    });
    
    it('inspects a multi-event log with updates', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };
      
      const assetData = createPeerAssetData('Original Name');
      let log = await createEventLog(assetData, options);
      log = await updateEventLog(log, { name: 'Updated Name', description: 'A description' }, options);
      log = await updateEventLog(log, { version: 2 }, options);
      
      const filePath = path.join(tempDir, 'multi-event.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.state).toBeDefined();
      expect(result.state?.name).toBe('Updated Name');
      expect(result.state?.metadata?.description).toBe('A description');
    });
    
    it('shows timestamps for each event', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };
      
      const assetData = createPeerAssetData('Timestamped Asset');
      let log = await createEventLog(assetData, options);
      // Include updatedAt to match how PeerCelManager.update() works
      log = await updateEventLog(log, { note: 'First update', updatedAt: new Date().toISOString() }, options);
      
      const filePath = path.join(tempDir, 'timestamps.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.state?.createdAt).toBeDefined();
      expect(result.state?.updatedAt).toBeDefined();
    });
  });
  
  describe('current state derivation', () => {
    it('derives current state from create event', async () => {
      const signer = createMockSigner();
      const resources: ExternalReference[] = [
        { digestMultibase: 'uXYZ123', mediaType: 'image/png' }
      ];
      const assetData = createPeerAssetData('Asset With Resources', resources);
      const log = await createEventLog(assetData, {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      });
      
      const filePath = path.join(tempDir, 'with-resources.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.state?.resources).toHaveLength(1);
      expect(result.state?.resources[0].mediaType).toBe('image/png');
    });
    
    it('shows deactivated state correctly', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };
      
      const assetData = createPeerAssetData('To Be Deactivated');
      let log = await createEventLog(assetData, options);
      log = await deactivateEventLog(log, 'No longer needed', options);
      
      const filePath = path.join(tempDir, 'deactivated.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.state?.deactivated).toBe(true);
      expect(result.state?.metadata?.deactivationReason).toBe('No longer needed');
    });
    
    it('updates state fields correctly through multiple updates', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };
      
      const assetData = createPeerAssetData('Version 1');
      let log = await createEventLog(assetData, options);
      log = await updateEventLog(log, { name: 'Version 2' }, options);
      log = await updateEventLog(log, { name: 'Version 3', custom: 'value' }, options);
      
      const filePath = path.join(tempDir, 'versioned.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.state?.name).toBe('Version 3');
      expect(result.state?.metadata?.custom).toBe('value');
    });
  });
  
  describe('witness attestations', () => {
    it('extracts witness proofs from events', async () => {
      const signer = createMockSigner();
      const assetData = createPeerAssetData('Witnessed Asset');
      const log = await createEventLog(assetData, {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      });
      
      // Add a witness proof
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
      
      const filePath = path.join(tempDir, 'witnessed.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(witnessedLog));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      // Witness info is displayed in output (verified by visual inspection)
    });
    
    it('handles multiple witnesses on different events', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };
      
      const assetData = createPeerAssetData('Multi-Witnessed');
      let log = await createEventLog(assetData, options);
      log = await updateEventLog(log, { note: 'Updated' }, options);
      
      // Add witness proofs to both events
      const witnessProof1: WitnessProof = {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: 'did:web:witness1.example.com#key-1',
        proofPurpose: 'assertionMethod',
        proofValue: 'z3WitnessProof1',
        witnessedAt: '2026-01-20T12:00:00Z',
      };
      
      const witnessProof2: WitnessProof = {
        type: 'DataIntegrityProof',
        cryptosuite: 'bitcoin-ordinals-2024',
        created: new Date().toISOString(),
        verificationMethod: 'did:btco:abc123#key-1',
        proofPurpose: 'assertionMethod',
        proofValue: 'z3BitcoinWitnessProof',
        witnessedAt: '2026-01-20T13:00:00Z',
      };
      
      const multiWitnessLog: EventLog = {
        events: [
          { ...log.events[0], proof: [...log.events[0].proof, witnessProof1] },
          { ...log.events[1], proof: [...log.events[1].proof, witnessProof2] },
        ],
      };
      
      const filePath = path.join(tempDir, 'multi-witnessed.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(multiWitnessLog));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
    });
  });
  
  describe('layer history', () => {
    it('shows layer transitions for migrated assets', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };
      
      // Create initial peer asset
      const assetData = createPeerAssetData('Migrating Asset');
      let log = await createEventLog(assetData, options);
      
      // Simulate webvh migration
      log = await updateEventLog(log, {
        sourceDid: 'did:peer:4z123456789abcdef',
        targetDid: 'did:webvh:example.com:asset123',
        layer: 'webvh',
        domain: 'example.com',
        migratedAt: new Date().toISOString(),
      }, options);
      
      const filePath = path.join(tempDir, 'migrated.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.state?.layer).toBe('webvh');
      expect(result.state?.did).toBe('did:webvh:example.com:asset123');
      expect(result.state?.metadata?.sourceDid).toBe('did:peer:4z123456789abcdef');
    });
    
    it('shows full migration path from peer to btco', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };
      
      // Create initial peer asset
      const assetData = createPeerAssetData('Full Migration Asset');
      let log = await createEventLog(assetData, options);
      
      // Simulate webvh migration
      log = await updateEventLog(log, {
        sourceDid: 'did:peer:4z123456789abcdef',
        targetDid: 'did:webvh:example.com:asset123',
        layer: 'webvh',
        domain: 'example.com',
        migratedAt: '2026-01-20T10:00:00Z',
      }, options);
      
      // Simulate btco migration
      log = await updateEventLog(log, {
        sourceDid: 'did:webvh:example.com:asset123',
        targetDid: 'did:btco:inscription123',
        layer: 'btco',
        txid: 'abc123def456',
        inscriptionId: 'inscription123',
        migratedAt: '2026-01-20T11:00:00Z',
      }, options);
      
      const filePath = path.join(tempDir, 'full-migration.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.state?.layer).toBe('btco');
      expect(result.state?.did).toBe('did:btco:inscription123');
      expect(result.state?.metadata?.txid).toBe('abc123def456');
    });
  });
  
  describe('CBOR format support', () => {
    it('inspects a CBOR event log', async () => {
      const signer = createMockSigner();
      const assetData = createPeerAssetData('CBOR Asset');
      const log = await createEventLog(assetData, {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      });
      
      const filePath = path.join(tempDir, 'test.cel.cbor');
      fs.writeFileSync(filePath, serializeEventLogCbor(log));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.state?.name).toBe('CBOR Asset');
      expect(result.state?.layer).toBe('peer');
    });
  });
  
  describe('error handling', () => {
    it('handles invalid JSON gracefully', async () => {
      const filePath = path.join(tempDir, 'invalid.cel.json');
      fs.writeFileSync(filePath, 'not valid json {{{');
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to load event log');
    });
    
    it('handles malformed event log structure', async () => {
      const filePath = path.join(tempDir, 'malformed.cel.json');
      fs.writeFileSync(filePath, JSON.stringify({ notEvents: [] }));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to load event log');
    });
    
    it('handles empty events array', async () => {
      const filePath = path.join(tempDir, 'empty.cel.json');
      fs.writeFileSync(filePath, JSON.stringify({ events: [] }));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to derive state');
    });
    
    it('handles event log without create event', async () => {
      // Create a log with only update event (invalid)
      const invalidLog: EventLog = {
        events: [{
          type: 'update',
          data: { name: 'Invalid' },
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
      
      const filePath = path.join(tempDir, 'no-create.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(invalidLog));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('First event must be a create event');
    });
  });
  
  describe('InspectResult structure', () => {
    it('includes state in successful result', async () => {
      const signer = createMockSigner();
      const assetData = createPeerAssetData('Result Test');
      const log = await createEventLog(assetData, {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      });
      
      const filePath = path.join(tempDir, 'result.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));
      
      const result = await inspectCommand({ log: filePath });
      
      expect(result.success).toBe(true);
      expect(result.state).toBeDefined();
      expect(result.state).toHaveProperty('did');
      expect(result.state).toHaveProperty('name');
      expect(result.state).toHaveProperty('layer');
      expect(result.state).toHaveProperty('resources');
      expect(result.state).toHaveProperty('deactivated');
    });
  });
});
