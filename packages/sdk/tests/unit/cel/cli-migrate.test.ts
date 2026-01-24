/**
 * CLI Migrate Command Tests
 * 
 * Tests for the migrate command implementation (US-023)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { migrateCommand, MigrateFlags } from '../../../src/cel/cli/migrate';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import { serializeEventLogJson } from '../../../src/cel/serialization/json';
import { serializeEventLogCbor } from '../../../src/cel/serialization/cbor';
import { parseEventLogJson } from '../../../src/cel/serialization/json';
import type { DataIntegrityProof, EventLog } from '../../../src/cel/types';
import { multikey } from '../../../src/crypto/Multikey';

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

// Create a test peer layer event log
async function createPeerLog(name: string = 'Test Asset'): Promise<EventLog> {
  const signer = createMockSigner();
  return await createEventLog({
    name,
    did: 'did:peer:4z6MkTestPeerDid12345',
    layer: 'peer',
    createdAt: new Date().toISOString(),
    resources: [],
    creator: 'did:peer:4z6MkTestPeerDid12345',
  }, {
    signer,
    verificationMethod: 'did:key:z6MkTest#key-1',
    proofPurpose: 'assertionMethod',
  });
}

// Create a test webvh layer event log (peer log that has been migrated)
async function createWebvhLog(name: string = 'Test Asset'): Promise<EventLog> {
  const peerLog = await createPeerLog(name);
  const signer = createMockSigner();
  
  // Add a migration event to simulate webvh migration
  return await updateEventLog(peerLog, {
    sourceDid: 'did:peer:4z6MkTestPeerDid12345',
    targetDid: 'did:webvh:example.com:testid',
    layer: 'webvh',
    domain: 'example.com',
    migratedAt: new Date().toISOString(),
  }, {
    signer,
    verificationMethod: 'did:key:z6MkTest#key-1',
    proofPurpose: 'assertionMethod',
  });
}

// Generate a test wallet file
async function createTestWallet(dir: string): Promise<string> {
  const ed25519 = await import('@noble/ed25519');
  const privateKeyBytes = ed25519.utils.randomPrivateKey();
  const privateKey = multikey.encodePrivateKey(privateKeyBytes as Uint8Array, 'Ed25519');
  
  const walletPath = path.join(dir, 'test-wallet.key');
  fs.writeFileSync(walletPath, privateKey);
  
  return walletPath;
}

describe('CLI Migrate Command', () => {
  let tempDir: string;
  
  beforeEach(() => {
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cel-migrate-test-'));
  });
  
  afterEach(() => {
    // Clean up temp files
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });
  
  describe('argument validation', () => {
    it('returns error when --log is missing', async () => {
      const result = await migrateCommand({ to: 'webvh', domain: 'example.com' });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('--log is required');
    });
    
    it('returns error when --to is missing', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'test.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({ log: logPath });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('--to is required');
    });
    
    it('returns error for invalid target layer', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'test.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({ log: logPath, to: 'invalid' });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid target layer');
    });
    
    it('returns error when --domain is missing for webvh migration', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'test.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({ log: logPath, to: 'webvh' });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('--domain is required');
    });
    
    it('returns error when --wallet is missing for btco migration', async () => {
      const log = await createWebvhLog();
      const logPath = path.join(tempDir, 'test.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({ log: logPath, to: 'btco' });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('--wallet is required');
    });
    
    it('returns error when log file does not exist', async () => {
      const result = await migrateCommand({
        log: '/nonexistent/file.json',
        to: 'webvh',
        domain: 'example.com',
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('File not found');
    });
    
    it('handles help flag', async () => {
      const result = await migrateCommand({ help: true });
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });
    
    it('handles -h flag', async () => {
      const result = await migrateCommand({ h: true });
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });
  });
  
  describe('peer to webvh migration', () => {
    it('successfully migrates peer log to webvh', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      const outputPath = path.join(tempDir, 'webvh.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'example.com',
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      expect(result.targetLayer).toBe('webvh');
      expect(result.targetDid).toContain('did:webvh:example.com');
      expect(fs.existsSync(outputPath)).toBe(true);
      
      // Verify output log has migration event
      const migratedLog = parseEventLogJson(fs.readFileSync(outputPath, 'utf-8'));
      expect(migratedLog.events.length).toBe(2); // create + migration
      expect(migratedLog.events[1].type).toBe('update');
      
      const migrationData = migratedLog.events[1].data as Record<string, unknown>;
      expect(migrationData.layer).toBe('webvh');
      expect(migrationData.domain).toBe('example.com');
    });
    
    it('includes sourceDid and targetDid in migration event', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      const outputPath = path.join(tempDir, 'webvh.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'test.org',
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      
      const migratedLog = parseEventLogJson(fs.readFileSync(outputPath, 'utf-8'));
      const migrationData = migratedLog.events[1].data as Record<string, unknown>;
      
      expect(migrationData.sourceDid).toBe('did:peer:4z6MkTestPeerDid12345');
      expect(migrationData.targetDid).toContain('did:webvh:test.org');
    });
    
    it('preserves hash chain in migrated log', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      const outputPath = path.join(tempDir, 'webvh.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'example.com',
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      
      const migratedLog = parseEventLogJson(fs.readFileSync(outputPath, 'utf-8'));
      
      // Migration event should have previousEvent linking to create event
      expect(migratedLog.events[1].previousEvent).toBeDefined();
      expect(typeof migratedLog.events[1].previousEvent).toBe('string');
      expect(migratedLog.events[1].previousEvent!.startsWith('u')).toBe(true);
    });
  });
  
  describe('webvh to btco migration', () => {
    it('successfully migrates webvh log to btco with wallet', async () => {
      const log = await createWebvhLog();
      const logPath = path.join(tempDir, 'webvh.cel.json');
      const outputPath = path.join(tempDir, 'btco.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'btco',
        wallet: walletPath,
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      expect(result.targetLayer).toBe('btco');
      expect(result.targetDid).toContain('did:btco');
      expect(fs.existsSync(outputPath)).toBe(true);
      
      // Verify output log has migration event
      const migratedLog = parseEventLogJson(fs.readFileSync(outputPath, 'utf-8'));
      expect(migratedLog.events.length).toBe(3); // create + webvh migration + btco migration
      
      const lastEvent = migratedLog.events[migratedLog.events.length - 1];
      const migrationData = lastEvent.data as Record<string, unknown>;
      expect(migrationData.layer).toBe('btco');
    });
    
    it('returns error for invalid wallet file', async () => {
      const log = await createWebvhLog();
      const logPath = path.join(tempDir, 'webvh.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'btco',
        wallet: '/nonexistent/wallet.key',
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Wallet file not found');
    });
  });
  
  describe('invalid migration paths', () => {
    it('returns error for direct peer to btco migration', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'btco',
        wallet: walletPath,
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Must migrate to webvh first');
    });
    
    it('returns error when migrating already at webvh to webvh', async () => {
      const log = await createWebvhLog();
      const logPath = path.join(tempDir, 'webvh.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'another.com',
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('already at webvh layer');
    });
  });
  
  describe('output formats', () => {
    it('outputs JSON by default', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      const outputPath = path.join(tempDir, 'output.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'example.com',
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      
      // Verify output is valid JSON
      const content = fs.readFileSync(outputPath, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });
    
    it('outputs CBOR when --format cbor is specified', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      const outputPath = path.join(tempDir, 'output.cel.cbor');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'example.com',
        output: outputPath,
        format: 'cbor',
      });
      
      expect(result.success).toBe(true);
      
      // Verify output exists and is binary
      const content = fs.readFileSync(outputPath);
      expect(content).toBeInstanceOf(Buffer);
      expect(content.length).toBeGreaterThan(0);
    });
    
    it('returns error for invalid format', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'example.com',
        format: 'xml', // Invalid format
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('--format must be');
    });
  });
  
  describe('CBOR input support', () => {
    it('reads CBOR input files', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.cbor');
      const outputPath = path.join(tempDir, 'webvh.cel.json');
      fs.writeFileSync(logPath, serializeEventLogCbor(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'example.com',
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
    });
  });
  
  describe('error handling', () => {
    it('handles invalid JSON gracefully', async () => {
      const logPath = path.join(tempDir, 'invalid.cel.json');
      fs.writeFileSync(logPath, 'not valid json {{{');
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'example.com',
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to load event log');
    });
    
    it('handles malformed event log structure', async () => {
      const logPath = path.join(tempDir, 'malformed.cel.json');
      fs.writeFileSync(logPath, JSON.stringify({ notEvents: [] }));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'example.com',
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to load event log');
    });
    
    it('handles empty events array', async () => {
      const logPath = path.join(tempDir, 'empty.cel.json');
      fs.writeFileSync(logPath, JSON.stringify({ events: [] }));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'example.com',
      });
      
      expect(result.success).toBe(false);
      // Should fail during layer detection or migration
      expect(result.message).toMatch(/empty|layer/i);
    });
  });
  
  describe('MigrateResult structure', () => {
    it('includes all expected fields on success', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      const outputPath = path.join(tempDir, 'webvh.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));
      
      const result = await migrateCommand({
        log: logPath,
        to: 'webvh',
        domain: 'example.com',
        output: outputPath,
      });
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('Migration complete');
      expect(result.log).toBeDefined();
      expect(result.sourceDid).toBeDefined();
      expect(result.targetDid).toBeDefined();
      expect(result.targetLayer).toBe('webvh');
    });
  });
});
