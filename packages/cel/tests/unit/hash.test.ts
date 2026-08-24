import { describe, test, expect } from 'bun:test';
import {
  computeDigestMultibase,
  verifyDigestMultibase,
  decodeDigestMultibase,
  digestMultibaseEquals,
  resourcePathSegment,
} from '../../src/hash';
import { multibase } from '../../src/utils/encoding';
import { sha256 } from '@noble/hashes/sha2.js';

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

    test('encodes a spec-conformant sha2-256 multihash with the 0x12 0x20 header (#258)', () => {
      const content = new TextEncoder().encode('hello');
      const digest = computeDigestMultibase(content);
      // Decode the raw multibase payload WITHOUT stripping the multihash header.
      const raw = multibase.decode(digest);
      expect(raw.length).toBe(34); // 2-byte multihash header + 32-byte digest
      expect(raw[0]).toBe(0x12); // sha2-256 multicodec code
      expect(raw[1]).toBe(0x20); // 32-byte length
      // Spec-conformant sha2-256 multihashes multibase-encode to a "uEi..." prefix.
      expect(digest.startsWith('uEi')).toBe(true);
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

    test('accepts a legacy bare (header-less) digest on the read path (#258)', () => {
      // A pre-fix value: 32 raw hash bytes multibase-encoded with NO multihash
      // header. Logs anchored on Bitcoin in this format are immutable, so the
      // read path must keep accepting it (write path emits multihash only).
      const raw = new Uint8Array(32).fill(7);
      const bare = multibase.encode(raw, 'base64url');
      expect(decodeDigestMultibase(bare)).toEqual(raw);
    });

    test('rejects values that are neither multihash nor a 32-byte bare digest', () => {
      const wrongLength = multibase.encode(new Uint8Array(31), 'base64url');
      expect(() => decodeDigestMultibase(wrongLength)).toThrow('Invalid digestMultibase');
      const wrongHeader = multibase.encode(
        Uint8Array.from([0x13, 0x20, ...new Uint8Array(32)]),
        'base64url'
      );
      expect(() => decodeDigestMultibase(wrongHeader)).toThrow('Invalid digestMultibase');
    });
  });

  describe('legacy interop (#258 tolerant read)', () => {
    test('verifyDigestMultibase accepts a legacy bare digest of the content', () => {
      const content = new TextEncoder().encode('anchored before the multihash fix');
      const legacy = multibase.encode(sha256(content), 'base64url');
      expect(verifyDigestMultibase(content, legacy)).toBe(true);
      // But a legacy digest of DIFFERENT content still fails
      expect(verifyDigestMultibase(new TextEncoder().encode('other'), legacy)).toBe(false);
    });

    test('digestMultibaseEquals matches legacy and multihash forms of the same digest', () => {
      const content = new TextEncoder().encode('same content, two encodings');
      const modern = computeDigestMultibase(content);
      const legacy = multibase.encode(sha256(content), 'base64url');
      expect(digestMultibaseEquals(modern, legacy)).toBe(true);
      expect(digestMultibaseEquals(legacy, modern)).toBe(true);
      expect(digestMultibaseEquals(modern, modern)).toBe(true);

      const other = computeDigestMultibase(new TextEncoder().encode('different'));
      expect(digestMultibaseEquals(modern, other)).toBe(false);
      expect(digestMultibaseEquals(legacy, other)).toBe(false);
      expect(digestMultibaseEquals('not-multibase', modern)).toBe(false);
    });
  });

  describe('resource path segments (one hash encoding)', () => {
    // Golden vectors from the real mainnet inscription
    // 8ad88c2ab862cb311da677e56ba5aea2edbfab459650decaad3406cf1081360bi0:
    // three encodings of the SAME sha256 digest of artwork.svg.
    const HEX = '74a170a58ea0fcb71ef08acab6facb6d199315fcb4821b5827199bcd8f2e6c23';
    const CANONICAL = 'uEiB0oXCljqD8tx7wisq2-sttGZMV_LSCG1gnGZvNjy5sIw';
    const LEGACY = 'udKFwpY6g_Lce8IrKtvrLbRmTFfy0ghtYJxmbzY8ubCM';

    test('resourcePathSegment emits the canonical multihash form (on-chain golden vector)', () => {
      expect(resourcePathSegment(HEX)).toBe(CANONICAL);
    });

    test('resourcePathSegment never emits the legacy raw-digest form', () => {
      // parseResourcePathSegment (the dual-form reader) is deleted — nothing
      // reads segments back and no legacy URL exists. The write side is
      // canonical-only: the golden vectors prove the two forms differ and
      // that only the canonical one is ever produced.
      expect(resourcePathSegment(HEX)).not.toBe(LEGACY);
      expect(resourcePathSegment(HEX).startsWith('uEi')).toBe(true);
    });

    test('resourcePathSegment agrees with computeDigestMultibase for the same content', () => {
      const content = new TextEncoder().encode('round trip');
      const digest = computeDigestMultibase(content);
      const hex = Array.from(sha256(content)).map((b) => b.toString(16).padStart(2, '0')).join('');
      expect(resourcePathSegment(hex)).toBe(digest);
    });

    test('resourcePathSegment rejects non-hex and wrong-length input', () => {
      expect(() => resourcePathSegment('nothex')).toThrow();
      expect(() => resourcePathSegment(HEX.slice(0, 62))).toThrow();
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
