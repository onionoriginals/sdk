/**
 * CLI Publish Command Tests
 *
 * Tests for the publish command (wrapper around migrate --to webvh)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { publishCommand } from '../../../src/cel/cli/publish';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { serializeEventLogJson } from '../../../src/cel/serialization/json';
import { parseEventLogJson } from '../../../src/cel/serialization/json';
import type { DataIntegrityProof } from '../../../src/cel/types';

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

describe('CLI Publish Command', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cel-publish-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('argument validation', () => {
    it('returns error when --log is missing', async () => {
      const result = await publishCommand({ domain: 'example.com' });

      expect(result.success).toBe(false);
      expect(result.message).toContain('--log is required');
    });

    it('returns error when --domain is missing', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'test.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await publishCommand({ log: logPath });

      expect(result.success).toBe(false);
      expect(result.message).toContain('--domain is required');
    });

    it('handles help flag', async () => {
      const result = await publishCommand({ help: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });

    it('handles -h flag', async () => {
      const result = await publishCommand({ h: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });
  });

  describe('publish (peer to webvh)', () => {
    it('successfully publishes peer log to webvh', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      const outputPath = path.join(tempDir, 'published.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await publishCommand({
        log: logPath,
        domain: 'example.com',
        output: outputPath,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Published');
      expect(result.targetDid).toContain('did:webvh:example.com');
      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it('produces valid migrated event log', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      const outputPath = path.join(tempDir, 'published.cel.json');
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      await publishCommand({
        log: logPath,
        domain: 'test.org',
        output: outputPath,
      });

      const publishedLog = parseEventLogJson(fs.readFileSync(outputPath, 'utf-8'));
      expect(publishedLog.events.length).toBe(2);
      expect(publishedLog.events[1].type).toBe('update');

      const migrationData = publishedLog.events[1].data as Record<string, unknown>;
      expect(migrationData.layer).toBe('webvh');
      expect(migrationData.domain).toBe('test.org');
    });

    it('supports CBOR output format', async () => {
      const log = await createPeerLog();
      const logPath = path.join(tempDir, 'peer.cel.json');
      const outputPath = path.join(tempDir, 'published.cel.cbor');
      fs.writeFileSync(logPath, serializeEventLogJson(log));

      const result = await publishCommand({
        log: logPath,
        domain: 'example.com',
        output: outputPath,
        format: 'cbor',
      });

      expect(result.success).toBe(true);
      const content = fs.readFileSync(outputPath);
      expect(content.length).toBeGreaterThan(0);
    });

    it('returns error when log file does not exist', async () => {
      const result = await publishCommand({
        log: '/nonexistent/file.json',
        domain: 'example.com',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('File not found');
    });
  });
});
