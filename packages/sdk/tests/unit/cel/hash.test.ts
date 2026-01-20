import { describe, test, expect } from 'bun:test';
import { 
  computeDigestMultibase, 
  verifyDigestMultibase, 
  decodeDigestMultibase 
} from '../../../src/cel/hash';

describe('CEL Hash Utilities', () => {
  describe('computeDigestMultibase', () => {
    test('returns multibase base64url-nopad encoded hash', () => {
      const content = new TextEncoder().encode('hello');
      const digest = computeDigestMultibase(content);
      
      // Should start with 'u' prefix (base64url-nopad multibase)
      expect(digest.startsWith('u')).toBe(true);
      
      // Should not contain padding characters
      expect(digest.includes('=')).toBe(false);
      
      // Should not contain base64 characters that are replaced in base64url
      expect(digest.includes('+')).toBe(false);
      expect(digest.includes('/')).toBe(false);
    });

    test('produces consistent hashes for same content', () => {
      const content = new TextEncoder().encode('test content');
      const digest1 = computeDigestMultibase(content);
      const digest2 = computeDigestMultibase(content);
      
      expect(digest1).toBe(digest2);
    });

    test('produces different hashes for different content', () => {
      const content1 = new TextEncoder().encode('hello');
      const content2 = new TextEncoder().encode('world');
      
      const digest1 = computeDigestMultibase(content1);
      const digest2 = computeDigestMultibase(content2);
      
      expect(digest1).not.toBe(digest2);
    });

    test('handles empty content', () => {
      const content = new Uint8Array(0);
      const digest = computeDigestMultibase(content);
      
      expect(digest.startsWith('u')).toBe(true);
      // Empty input should still produce a valid 32-byte SHA-256 hash
      // SHA-256 of empty is: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    });

    test('handles binary content', () => {
      const content = new Uint8Array([0x00, 0xFF, 0x80, 0x7F]);
      const digest = computeDigestMultibase(content);
      
      expect(digest.startsWith('u')).toBe(true);
    });

    test('hash length is consistent (SHA-256 produces 32 bytes)', () => {
      const content1 = new TextEncoder().encode('short');
      const content2 = new TextEncoder().encode('a much longer string that should still produce the same length hash');
      
      const digest1 = computeDigestMultibase(content1);
      const digest2 = computeDigestMultibase(content2);
      
      // Both should decode to 32 bytes (SHA-256 output)
      const decoded1 = decodeDigestMultibase(digest1);
      const decoded2 = decodeDigestMultibase(digest2);
      
      expect(decoded1.length).toBe(32);
      expect(decoded2.length).toBe(32);
    });
  });

  describe('verifyDigestMultibase', () => {
    test('returns true for matching content and digest', () => {
      const content = new TextEncoder().encode('hello world');
      const digest = computeDigestMultibase(content);
      
      expect(verifyDigestMultibase(content, digest)).toBe(true);
    });

    test('returns false for non-matching content', () => {
      const content1 = new TextEncoder().encode('hello');
      const content2 = new TextEncoder().encode('world');
      const digest = computeDigestMultibase(content1);
      
      expect(verifyDigestMultibase(content2, digest)).toBe(false);
    });

    test('returns false for invalid digest format', () => {
      const content = new TextEncoder().encode('hello');
      
      // Invalid prefix
      expect(verifyDigestMultibase(content, 'xInvalidDigest')).toBe(false);
      
      // Empty string
      expect(verifyDigestMultibase(content, '')).toBe(false);
      
      // Not multibase encoded
      expect(verifyDigestMultibase(content, 'plaintext')).toBe(false);
    });

    test('returns true for empty content with correct digest', () => {
      const content = new Uint8Array(0);
      const digest = computeDigestMultibase(content);
      
      expect(verifyDigestMultibase(content, digest)).toBe(true);
    });
  });

  describe('decodeDigestMultibase', () => {
    test('decodes base64url multibase to bytes', () => {
      const content = new TextEncoder().encode('test');
      const digest = computeDigestMultibase(content);
      const decoded = decodeDigestMultibase(digest);
      
      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(decoded.length).toBe(32); // SHA-256 output
    });

    test('throws on invalid multibase prefix', () => {
      expect(() => decodeDigestMultibase('xInvalid')).toThrow();
    });
  });

  describe('CEL spec compliance', () => {
    test('digest format matches CEL specification', () => {
      // CEL spec requires digestMultibase to be:
      // - Multibase base64url-nopad encoded (prefix 'u')
      // - SHA-256 hash
      
      const content = new TextEncoder().encode('CEL test content');
      const digest = computeDigestMultibase(content);
      
      // Validate format
      expect(digest[0]).toBe('u'); // Multibase base64url prefix
      
      // Decode and verify it's a valid SHA-256 hash (32 bytes)
      const hashBytes = decodeDigestMultibase(digest);
      expect(hashBytes.length).toBe(32);
      
      // Re-verification should pass
      expect(verifyDigestMultibase(content, digest)).toBe(true);
    });

    test('roundtrip: compute, decode, verify', () => {
      const originalContent = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      
      // Compute digest
      const digest = computeDigestMultibase(originalContent);
      
      // Should be able to decode back to hash bytes
      const hashBytes = decodeDigestMultibase(digest);
      expect(hashBytes.length).toBe(32);
      
      // Verification should pass
      expect(verifyDigestMultibase(originalContent, digest)).toBe(true);
      
      // Modified content should fail verification
      const modifiedContent = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9]);
      expect(verifyDigestMultibase(modifiedContent, digest)).toBe(false);
    });
  });
});
