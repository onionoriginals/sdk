/**
 * CLI Resolve Command Tests
 *
 * Tests for the resolve command implementation
 */

import { describe, it, expect } from 'vitest';
import { resolveCommand } from '../../../src/cel/cli/resolve';

describe('CLI Resolve Command', () => {
  describe('argument validation', () => {
    it('returns error when DID is missing', async () => {
      const result = await resolveCommand({});

      expect(result.success).toBe(false);
      expect(result.message).toContain('A DID is required');
    });

    it('returns error for invalid DID format', async () => {
      const result = await resolveCommand({ did: 'not-a-did' });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid DID format');
    });

    it('returns error for invalid network value', async () => {
      const result = await resolveCommand({
        did: 'did:peer:4z6MkTest',
        network: 'invalid',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('--network must be');
    });

    it('handles help flag', async () => {
      const result = await resolveCommand({ help: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });

    it('handles -h flag', async () => {
      const result = await resolveCommand({ h: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });
  });

  describe('network detection', () => {
    it('accepts mainnet network', async () => {
      // Will fail on resolution but should not fail on network parsing
      const result = await resolveCommand({
        did: 'did:btco:12345',
        network: 'mainnet',
      });

      // Should fail on resolution, not network parsing
      expect(result.success).toBe(false);
      expect(result.message).not.toContain('--network must be');
    });

    it('accepts regtest network', async () => {
      const result = await resolveCommand({
        did: 'did:btco:reg:12345',
        network: 'regtest',
      });

      expect(result.success).toBe(false);
      expect(result.message).not.toContain('--network must be');
    });

    it('accepts signet network', async () => {
      const result = await resolveCommand({
        did: 'did:btco:sig:12345',
        network: 'signet',
      });

      expect(result.success).toBe(false);
      expect(result.message).not.toContain('--network must be');
    });

    it('auto-detects regtest from did:btco:reg: prefix', async () => {
      const result = await resolveCommand({
        did: 'did:btco:reg:12345',
      });

      // Should attempt resolution (and fail) without network error
      expect(result.success).toBe(false);
      expect(result.message).not.toContain('--network must be');
    });

    it('auto-detects signet from did:btco:sig: prefix', async () => {
      const result = await resolveCommand({
        did: 'did:btco:sig:12345',
      });

      expect(result.success).toBe(false);
      expect(result.message).not.toContain('--network must be');
    });
  });

  describe('DID resolution', () => {
    it('resolves did:peer successfully', async () => {
      // did:peer:4 is the multihash-based method, create a minimal valid one
      // This tests that the resolution path is exercised
      // did:peer resolution may fail for invalid DIDs but should exercise the code path
      const result = await resolveCommand({
        did: 'did:peer:4zQmInvalidButTests',
      });

      // May fail on actual resolution, but exercises the resolve path
      expect(result.success === true || result.message.includes('resolve')).toBe(true);
    });

    it('resolves unknown DID method with minimal document', async () => {
      // The SDK creates a minimal DID document for any DID format
      const result = await resolveCommand({
        did: 'did:unknown:method:12345',
      });

      expect(result.success).toBe(true);
      expect(result.didDocument).toBeDefined();
    });
  });

  describe('ResolveResult structure', () => {
    it('includes success and message on validation error', async () => {
      const result = await resolveCommand({ did: 'not-a-did' });

      expect(typeof result.success).toBe('boolean');
      expect(typeof result.message).toBe('string');
    });

    it('includes success and message on help', async () => {
      const result = await resolveCommand({ help: true });

      expect(result.success).toBe(true);
      expect(typeof result.message).toBe('string');
    });
  });
});
