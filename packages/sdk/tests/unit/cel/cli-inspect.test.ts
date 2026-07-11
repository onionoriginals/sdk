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
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { deriveDidCel } from '../../../src/cel/celDid';
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

// LEGACY genesis shape (pre-did:cel): embeds did/layer/creator.
// Kept as the legacy-fixture per behavior; the write path emits CelAssetData.
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

// New-shape genesis (CelAssetData): identity is DERIVED (did:cel), never embedded.
function createCelAssetData(name: string, resources: ExternalReference[] = []) {
  return {
    name,
    controller: 'did:key:z6MkTest',
    resources,
    createdAt: new Date().toISOString(),
    nonce: 'uVGVzdE5vbmNlMTIzNDU2',
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
      
      const assetData = createCelAssetData('Original Name');
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
      const assetData = createCelAssetData('Asset With Resources', resources);
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
      // New-shape genesis: the DID is derived (did:cel), the creator is the controller.
      expect(result.state?.did).toBe(deriveDidCel(log));
      expect(result.state?.creator).toBe('did:key:z6MkTest');
      expect(result.state?.layer).toBe('peer');
    });
    
    it('shows deactivated state correctly', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };
      
      const assetData = createCelAssetData('To Be Deactivated');
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

    it('does not let a stray did/layer field on an update event clobber a new-shape derived identity', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };

      const assetData = createCelAssetData('Genesis Asset');
      let log = await createEventLog(assetData, options);
      const expectedDid = deriveDidCel(log);

      // Stray did/layer fields on a plain update must be ignored for new-shape logs.
      log = await updateEventLog(log, {
        layer: 'btco',
        did: 'did:btco:999',
      }, options);

      const filePath = path.join(tempDir, 'new-shape-stray-update.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      const result = await inspectCommand({ log: filePath });

      expect(result.success).toBe(true);
      expect(result.state?.did).toBe(expectedDid);
      expect(result.state?.layer).toBe('peer');
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
    
    it('shows full migration path from peer to btco (legacy update-sniffed events)', async () => {
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

  describe('first-class event types (did:cel era)', () => {
    const witnessProofFor = (satoshi: string) => ({
      type: 'DataIntegrityProof' as const,
      cryptosuite: 'bitcoin-ordinals-2024',
      created: '2026-01-20T11:00:00Z',
      verificationMethod: 'did:btco:witness#key-1',
      proofPurpose: 'assertionMethod',
      proofValue: 'z3BitcoinWitnessProof',
      witnessedAt: '2026-01-20T11:00:00Z',
      txid: 'abc123def456',
      inscriptionId: 'inscription123i0',
      satoshi,
    });

    it('state replay applies a migrate-typed event (layer, did, sourceDid)', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };

      let log = await createEventLog(createCelAssetData('Migrating Asset'), options);
      const sourceDid = deriveDidCel(log);
      log = await appendEvent(log, 'migrate', {
        sourceDid,
        targetDid: 'did:webvh:example.com:asset123',
        layer: 'webvh',
        domain: 'example.com',
        migratedAt: '2026-01-20T10:00:00Z',
      }, options);

      const filePath = path.join(tempDir, 'first-class-migrate.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      const result = await inspectCommand({ log: filePath });

      expect(result.success).toBe(true);
      expect(result.state?.layer).toBe('webvh');
      expect(result.state?.did).toBe('did:webvh:example.com:asset123');
      expect(result.state?.metadata?.sourceDid).toBe(sourceDid);
      expect(result.state?.metadata?.domain).toBe('example.com');
      expect(result.state?.updatedAt).toBe('2026-01-20T10:00:00Z');
    });

    it('displays migrate-typed events in the layer history section', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };

      let log = await createEventLog(createCelAssetData('History Asset'), options);
      log = await appendEvent(log, 'migrate', {
        sourceDid: deriveDidCel(log),
        targetDid: 'did:webvh:example.com:hist1',
        layer: 'webvh',
        domain: 'example.com',
        migratedAt: '2026-01-20T10:00:00Z',
      }, options);

      const filePath = path.join(tempDir, 'history.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      const logged: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => logged.push(args.join(' '));
      let result;
      try {
        result = await inspectCommand({ log: filePath });
      } finally {
        console.log = orig;
      }

      expect(result.success).toBe(true);
      const output = logged.join('\n');
      // Layer history section renders only when >1 entries — the migrate-typed
      // event must contribute the webvh entry.
      expect(output).toContain('LAYER HISTORY');
      expect(output).toContain('WebVH');
      // Timeline shows a MIGRATE badge for the first-class event.
      expect(output).toContain('MIGRATE');
    });

    it('derives did:btco from the bitcoin witness proof on a migrate-typed btco event', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };

      let log = await createEventLog(createCelAssetData('Btco Asset'), options);
      log = await appendEvent(log, 'migrate', {
        sourceDid: deriveDidCel(log),
        targetDid: 'did:webvh:example.com:btco1',
        layer: 'webvh',
        domain: 'example.com',
        migratedAt: '2026-01-20T10:00:00Z',
      }, options);
      log = await appendEvent(log, 'migrate', {
        sourceDid: 'did:webvh:example.com:btco1',
        layer: 'btco',
        migratedAt: '2026-01-20T11:00:00Z',
      }, options);

      // Attach the bitcoin witness proof carrying the satoshi (added after
      // signing, as BtcoCelManager does).
      const last = log.events[log.events.length - 1];
      log = {
        events: [
          ...log.events.slice(0, -1),
          { ...last, proof: [...last.proof, witnessProofFor('123456789')] },
        ],
      };

      const filePath = path.join(tempDir, 'btco-migrate.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      const result = await inspectCommand({ log: filePath });

      expect(result.success).toBe(true);
      expect(result.state?.layer).toBe('btco');
      expect(result.state?.did).toBe('did:btco:123456789');
      expect(result.state?.metadata?.txid).toBe('abc123def456');
      expect(result.state?.metadata?.inscriptionId).toBe('inscription123i0');
    });

    it('state replay applies a transfer-typed event (owners, timestamp; identity unchanged)', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };

      let log = await createEventLog(createCelAssetData('Owned Asset'), options);
      const did = deriveDidCel(log);
      log = await appendEvent(log, 'transfer', {
        previousOwner: did,
        newOwner: 'bc1qnewowner',
        transferredAt: '2026-01-21T09:00:00Z',
      }, options);

      const filePath = path.join(tempDir, 'transferred.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      const result = await inspectCommand({ log: filePath });

      expect(result.success).toBe(true);
      expect(result.state?.did).toBe(did);
      expect(result.state?.metadata?.previousOwner).toBe(did);
      expect(result.state?.metadata?.newOwner).toBe('bc1qnewowner');
      expect(result.state?.updatedAt).toBe('2026-01-21T09:00:00Z');
    });

    it('state replay applies a rotateKey-typed event (controller hand-off)', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };

      let log = await createEventLog(createCelAssetData('Rotating Asset'), options);
      log = await appendEvent(log, 'rotateKey', {
        previousController: 'did:key:z6MkTest',
        newController: 'did:key:z6MkNewController',
        rotatedAt: '2026-01-22T08:00:00Z',
      }, options);

      const filePath = path.join(tempDir, 'rotated.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      const result = await inspectCommand({ log: filePath });

      expect(result.success).toBe(true);
      expect(result.state?.controller).toBe('did:key:z6MkNewController');
      expect(result.state?.updatedAt).toBe('2026-01-22T08:00:00Z');
    });

    it('timeline displays TRANSFER and ROTATEKEY badges with details', async () => {
      const signer = createMockSigner();
      const options = {
        signer,
        verificationMethod: 'did:key:z6MkTest#key-1',
        proofPurpose: 'assertionMethod',
      };

      let log = await createEventLog(createCelAssetData('Badge Asset'), options);
      log = await appendEvent(log, 'transfer', {
        previousOwner: deriveDidCel(log),
        newOwner: 'bc1qbadges',
        transferredAt: '2026-01-21T09:00:00Z',
      }, options);
      log = await appendEvent(log, 'rotateKey', {
        previousController: 'did:key:z6MkTest',
        newController: 'did:key:z6MkNext',
        rotatedAt: '2026-01-22T08:00:00Z',
      }, options);

      const filePath = path.join(tempDir, 'badges.cel.json');
      fs.writeFileSync(filePath, serializeEventLogJson(log));

      const logged: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => logged.push(args.join(' '));
      let result;
      try {
        result = await inspectCommand({ log: filePath });
      } finally {
        console.log = orig;
      }

      expect(result.success).toBe(true);
      const output = logged.join('\n');
      expect(output).toContain('TRANSFER');
      expect(output).toContain('ROTATEKEY');
      expect(output).toContain('bc1qbadges');
      expect(output).toContain('did:key:z6MkNext');
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
