/**
 * CLI Inscribe Command Tests
 *
 * Tests for the inscribe command (wrapper around migrate --to btco)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { inscribeCommand } from '../../../src/cel/cli/inscribe';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import { serializeEventLogJson } from '../../../src/cel/serialization/json';
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

describe('CLI Inscribe Command', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cel-inscribe-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('argument validation', () => {
    it('returns error when --log is missing', async () => {
      const result = await inscribeCommand({ wallet: '/some/wallet.key' });

      expect(result.success).toBe(false);
      expect(result.message).toContain('--log is required');
    });

    it('returns error when --wallet is missing', async () => {
      const log = await createWebvhLog();
      const logPath = path.join(tempDir, 'test.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await inscribeCommand({ log: logPath });

      expect(result.success).toBe(false);
      expect(result.message).toContain('--wallet is required');
    });

    it('handles help flag', async () => {
      const result = await inscribeCommand({ help: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });

    it('handles -h flag', async () => {
      const result = await inscribeCommand({ h: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });
  });

  describe('inscribe (webvh to btco)', () => {
    it('successfully inscribes webvh log to btco', async () => {
      const log = await createWebvhLog();
      const logPath = path.join(tempDir, 'webvh.cel.json');
      const outputPath = path.join(tempDir, 'inscribed.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await inscribeCommand({
        log: logPath,
        wallet: walletPath,
        output: outputPath,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Inscribed');
      expect(result.targetDid).toContain('did:btco');
      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it('produces valid migrated event log', async () => {
      const log = await createWebvhLog();
      const logPath = path.join(tempDir, 'webvh.cel.json');
      const outputPath = path.join(tempDir, 'inscribed.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      await inscribeCommand({
        log: logPath,
        wallet: walletPath,
        output: outputPath,
      });

      const inscribedLog = parseEventLogJson(fs.readFileSync(outputPath, 'utf-8'));
      expect(inscribedLog.events.length).toBe(3); // create + webvh + btco

      const lastEvent = inscribedLog.events[inscribedLog.events.length - 1];
      const migrationData = lastEvent.data as Record<string, unknown>;
      expect(migrationData.layer).toBe('btco');
    });

    it('returns error for peer log (must be webvh first)', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await inscribeCommand({
        log: logPath,
        wallet: walletPath,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Must migrate to webvh first');
    });

    it('returns error for invalid wallet file', async () => {
      const log = await createWebvhLog();
      const logPath = path.join(tempDir, 'webvh.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await inscribeCommand({
        log: logPath,
        wallet: '/nonexistent/wallet.key',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Wallet file not found');
    });

    it('supports CBOR output format', async () => {
      const log = await createWebvhLog();
      const logPath = path.join(tempDir, 'webvh.cel.json');
      const outputPath = path.join(tempDir, 'inscribed.cel.cbor');
      const walletPath = await createTestWallet(tempDir);
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await inscribeCommand({
        log: logPath,
        wallet: walletPath,
        output: outputPath,
        format: 'cbor',
      });

      expect(result.success).toBe(true);
      const content = fs.readFileSync(outputPath);
      expect(content.length).toBeGreaterThan(0);
    });
  });
});
