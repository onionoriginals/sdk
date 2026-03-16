/**
 * CLI Transfer Command Tests
 *
 * Tests for the transfer command implementation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { transferCommand } from '../../../src/cel/cli/transfer';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import { serializeEventLogJson } from '../../../src/cel/serialization/json';
import { serializeEventLogCbor } from '../../../src/cel/serialization/cbor';
import { parseEventLogJson } from '../../../src/cel/serialization/json';
import type { DataIntegrityProof, EventLog } from '../../../src/cel/types';
import { multikey } from '../../../src/crypto/Multikey';

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

async function createPeerLog(name: string = 'Test Asset') {
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

async function createWebvhLog(name: string = 'Test Asset'): Promise<EventLog> {
  const peerLog = await createPeerLog(name);
  const signer = createMockSigner();

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

async function createTestWallet(dir: string): Promise<string> {
  const ed25519 = await import('@noble/ed25519');
  const privateKeyBytes = ed25519.utils.randomPrivateKey();
  const privateKey = multikey.encodePrivateKey(privateKeyBytes as Uint8Array, 'Ed25519');

  const walletPath = path.join(dir, 'test-wallet.key');
  fs.writeFileSync(walletPath, privateKey);

  return walletPath;
}

async function createJsonWallet(dir: string): Promise<string> {
  const ed25519 = await import('@noble/ed25519');
  const privateKeyBytes = ed25519.utils.randomPrivateKey();
  const privateKey = multikey.encodePrivateKey(privateKeyBytes as Uint8Array, 'Ed25519');

  const walletPath = path.join(dir, 'test-wallet.json');
  fs.writeFileSync(walletPath, JSON.stringify({ privateKey }));

  return walletPath;
}

describe('CLI Transfer Command', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cel-transfer-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('argument validation', () => {
    it('returns error when --log is missing', async () => {
      const result = await transferCommand({ to: 'bc1qtest', wallet: '/some/wallet.key' });

      expect(result.success).toBe(false);
      expect(result.message).toContain('--log is required');
    });

    it('returns error when --to is missing', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'test.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await transferCommand({ log: logPath, wallet: '/some/wallet.key' });

      expect(result.success).toBe(false);
      expect(result.message).toContain('--to is required');
    });

    it('returns error when --wallet is missing', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'test.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await transferCommand({ log: logPath, to: 'bc1qtest' });

      expect(result.success).toBe(false);
      expect(result.message).toContain('--wallet is required');
    });

    it('handles help flag', async () => {
      const result = await transferCommand({ help: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });

    it('handles -h flag', async () => {
      const result = await transferCommand({ h: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });
  });

  describe('transfer execution', () => {
    it('successfully transfers ownership to Bitcoin address', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      const outputPath = path.join(tempDir, 'transferred.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await transferCommand({
        log: logPath,
        to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        wallet: walletPath,
        output: outputPath,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Transfer recorded');
      expect(result.previousOwner).toBe('did:peer:4z6MkTestPeerDid12345');
      expect(result.newOwner).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it('successfully transfers ownership to a DID', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      const outputPath = path.join(tempDir, 'transferred.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await transferCommand({
        log: logPath,
        to: 'did:btco:12345',
        wallet: walletPath,
        output: outputPath,
      });

      expect(result.success).toBe(true);
      expect(result.newOwner).toBe('did:btco:12345');
    });

    it('appends transfer event to the event log', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      const outputPath = path.join(tempDir, 'transferred.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
        output: outputPath,
      });

      const transferredLog = parseEventLogJson(fs.readFileSync(outputPath, 'utf-8'));
      expect(transferredLog.events.length).toBe(2); // create + transfer

      const transferEvent = transferredLog.events[1];
      expect(transferEvent.type).toBe('update');

      const transferData = transferEvent.data as Record<string, unknown>;
      expect(transferData.type).toBe('transfer');
      expect(transferData.previousOwner).toBe('did:peer:4z6MkTestPeerDid12345');
      expect(transferData.newOwner).toBe('bc1qtest');
      expect(transferData.transferredAt).toBeDefined();
    });

    it('includes proof on transfer event', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      const outputPath = path.join(tempDir, 'transferred.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
        output: outputPath,
      });

      const transferredLog = parseEventLogJson(fs.readFileSync(outputPath, 'utf-8'));
      const transferEvent = transferredLog.events[1];

      expect(transferEvent.proof).toBeDefined();
      expect(transferEvent.proof!.length).toBeGreaterThan(0);
      expect(transferEvent.proof![0].type).toBe('DataIntegrityProof');
      expect(transferEvent.proof![0].cryptosuite).toBe('eddsa-jcs-2022');
      expect(transferEvent.proof![0].proofValue).toBeDefined();
    });

    it('preserves hash chain with previousEvent', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      const outputPath = path.join(tempDir, 'transferred.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
        output: outputPath,
      });

      const transferredLog = parseEventLogJson(fs.readFileSync(outputPath, 'utf-8'));
      const transferEvent = transferredLog.events[1];

      expect(transferEvent.previousEvent).toBeDefined();
      expect(typeof transferEvent.previousEvent).toBe('string');
    });

    it('works with webvh event log', async () => {
      const log = await createWebvhLog();
      const logPath = path.join(tempDir, 'webvh.cel.json');
      const outputPath = path.join(tempDir, 'transferred.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
        output: outputPath,
      });

      expect(result.success).toBe(true);
      expect(result.previousOwner).toBe('did:webvh:example.com:testid');
    });

    it('loads JSON format wallet', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      const outputPath = path.join(tempDir, 'transferred.cel.json');
      const walletPath = await createJsonWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
        output: outputPath,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('output formats', () => {
    it('outputs JSON by default', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      const outputPath = path.join(tempDir, 'transferred.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
        output: outputPath,
      });

      expect(result.success).toBe(true);
      const content = fs.readFileSync(outputPath, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('outputs CBOR when --format cbor is specified', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      const outputPath = path.join(tempDir, 'transferred.cel.cbor');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
        output: outputPath,
        format: 'cbor',
      });

      expect(result.success).toBe(true);
      const content = fs.readFileSync(outputPath);
      expect(content.length).toBeGreaterThan(0);
    });

    it('returns error for invalid format', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
        format: 'xml',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('--format must be');
    });
  });

  describe('CBOR input support', () => {
    it('reads CBOR input files', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.cbor');
      const outputPath = path.join(tempDir, 'transferred.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogCbor(log));

      const result = await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
        output: outputPath,
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns error when log file does not exist', async () => {
      const walletPath = await createTestWallet(tempDir);

      const result = await transferCommand({
        log: '/nonexistent/file.json',
        to: 'bc1qtest',
        wallet: walletPath,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('File not found');
    });

    it('returns error when wallet file does not exist', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: '/nonexistent/wallet.key',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Wallet file not found');
    });

    it('returns error for invalid wallet content', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const walletPath = path.join(tempDir, 'bad-wallet.key');
      fs.writeFileSync(walletPath, 'not-a-valid-key');

      const result = await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to load wallet');
    });

    it('handles invalid JSON log gracefully', async () => {
      const logPath = path.join(tempDir, 'invalid.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, 'not valid json {{{');

      const result = await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to load event log');
    });
  });

  describe('TransferResult structure', () => {
    it('includes all expected fields on success', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'asset.cel.json');
      const outputPath = path.join(tempDir, 'transferred.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await transferCommand({
        log: logPath,
        to: 'bc1qtest',
        wallet: walletPath,
        output: outputPath,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
      expect(result.log).toBeDefined();
      expect(result.previousOwner).toBeDefined();
      expect(result.newOwner).toBe('bc1qtest');
    });
  });
});
