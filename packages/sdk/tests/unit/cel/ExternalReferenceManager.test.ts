/**
 * Unit tests for ExternalReferenceManager
 * 
 * Tests the creation and verification of external references
 * as specified in the CEL specification.
 */

import { describe, it, expect } from 'bun:test';
import {
  createExternalReference,
  verifyExternalReference,
} from '../../../src/cel/ExternalReferenceManager';
import { computeDigestMultibase } from '../../../src/cel/hash';

describe('ExternalReferenceManager', () => {
  describe('createExternalReference', () => {
    it('should create reference with correct digestMultibase', () => {
      const content = new TextEncoder().encode('hello world');
      const ref = createExternalReference(content, 'text/plain');
      
      // Verify digest is computed correctly
      const expectedDigest = computeDigestMultibase(content);
      expect(ref.digestMultibase).toBe(expectedDigest);
    });

    it('should include mediaType in reference', () => {
      const content = new TextEncoder().encode('test');
      const ref = createExternalReference(content, 'image/png');
      
      expect(ref.mediaType).toBe('image/png');
    });

    it('should include urls when provided', () => {
      const content = new TextEncoder().encode('test');
      const urls = ['https://example.com/file.png', 'ipfs://Qm...'];
      const ref = createExternalReference(content, 'image/png', urls);
      
      expect(ref.url).toEqual(urls);
    });

    it('should not include url field when urls not provided', () => {
      const content = new TextEncoder().encode('test');
      const ref = createExternalReference(content, 'text/plain');
      
      expect(ref.url).toBeUndefined();
    });

    it('should not include url field when empty array provided', () => {
      const content = new TextEncoder().encode('test');
      const ref = createExternalReference(content, 'text/plain', []);
      
      expect(ref.url).toBeUndefined();
    });

    it('should handle binary content correctly', () => {
      const binaryContent = new Uint8Array([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
      const ref = createExternalReference(binaryContent, 'application/octet-stream');
      
      expect(ref.digestMultibase).toMatch(/^u/); // Should have multibase prefix
      expect(ref.mediaType).toBe('application/octet-stream');
    });

    it('should handle empty content', () => {
      const emptyContent = new Uint8Array([]);
      const ref = createExternalReference(emptyContent, 'text/plain');
      
      // SHA-256 of empty input has a known hash
      expect(ref.digestMultibase).toBeTruthy();
      expect(ref.mediaType).toBe('text/plain');
    });

    it('should handle large content', () => {
      // 1MB of random-ish data
      const largeContent = new Uint8Array(1024 * 1024);
      for (let i = 0; i < largeContent.length; i++) {
        largeContent[i] = i % 256;
      }
      const ref = createExternalReference(largeContent, 'application/octet-stream');
      
      expect(ref.digestMultibase).toBeTruthy();
      expect(ref.mediaType).toBe('application/octet-stream');
    });

    it('should produce different digests for different content', () => {
      const content1 = new TextEncoder().encode('hello');
      const content2 = new TextEncoder().encode('world');
      
      const ref1 = createExternalReference(content1, 'text/plain');
      const ref2 = createExternalReference(content2, 'text/plain');
      
      expect(ref1.digestMultibase).not.toBe(ref2.digestMultibase);
    });

    it('should produce same digest for same content', () => {
      const content = new TextEncoder().encode('identical content');
      
      const ref1 = createExternalReference(content, 'text/plain');
      const ref2 = createExternalReference(content, 'text/plain');
      
      expect(ref1.digestMultibase).toBe(ref2.digestMultibase);
    });

    it('should handle single url', () => {
      const content = new TextEncoder().encode('test');
      const ref = createExternalReference(content, 'text/plain', ['https://example.com/file.txt']);
      
      expect(ref.url).toEqual(['https://example.com/file.txt']);
      expect(ref.url?.length).toBe(1);
    });

    it('should handle multiple urls', () => {
      const content = new TextEncoder().encode('test');
      const urls = [
        'https://primary.example.com/file.txt',
        'https://backup.example.com/file.txt',
        'ipfs://QmHash...',
      ];
      const ref = createExternalReference(content, 'text/plain', urls);
      
      expect(ref.url).toEqual(urls);
      expect(ref.url?.length).toBe(3);
    });

    it('should handle various media types', () => {
      const content = new TextEncoder().encode('test');
      
      const mediaTypes = [
        'text/plain',
        'text/html',
        'application/json',
        'image/png',
        'image/jpeg',
        'video/mp4',
        'audio/mpeg',
        'application/pdf',
        'application/octet-stream',
      ];
      
      for (const mediaType of mediaTypes) {
        const ref = createExternalReference(content, mediaType);
        expect(ref.mediaType).toBe(mediaType);
      }
    });
  });

  describe('verifyExternalReference', () => {
    it('should return true for matching content', () => {
      const content = new TextEncoder().encode('hello world');
      const ref = createExternalReference(content, 'text/plain');
      
      const isValid = verifyExternalReference(ref, content);
      expect(isValid).toBe(true);
    });

    it('should return false for different content', () => {
      const content = new TextEncoder().encode('hello world');
      const ref = createExternalReference(content, 'text/plain');
      
      const differentContent = new TextEncoder().encode('different content');
      const isValid = verifyExternalReference(ref, differentContent);
      expect(isValid).toBe(false);
    });

    it('should return false for modified content', () => {
      const content = new TextEncoder().encode('hello world');
      const ref = createExternalReference(content, 'text/plain');
      
      // Modify one byte
      const modified = new Uint8Array(content);
      modified[0] = modified[0] + 1;
      
      const isValid = verifyExternalReference(ref, modified);
      expect(isValid).toBe(false);
    });

    it('should return false for truncated content', () => {
      const content = new TextEncoder().encode('hello world');
      const ref = createExternalReference(content, 'text/plain');
      
      // Truncate the content
      const truncated = content.slice(0, content.length - 1);
      
      const isValid = verifyExternalReference(ref, truncated);
      expect(isValid).toBe(false);
    });

    it('should return false for extended content', () => {
      const content = new TextEncoder().encode('hello world');
      const ref = createExternalReference(content, 'text/plain');
      
      // Extend the content
      const extended = new Uint8Array(content.length + 1);
      extended.set(content);
      extended[content.length] = 0;
      
      const isValid = verifyExternalReference(ref, extended);
      expect(isValid).toBe(false);
    });

    it('should verify empty content correctly', () => {
      const emptyContent = new Uint8Array([]);
      const ref = createExternalReference(emptyContent, 'text/plain');
      
      expect(verifyExternalReference(ref, emptyContent)).toBe(true);
      expect(verifyExternalReference(ref, new Uint8Array([0]))).toBe(false);
    });

    it('should verify binary content correctly', () => {
      const binaryContent = new Uint8Array([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
      const ref = createExternalReference(binaryContent, 'application/octet-stream');
      
      expect(verifyExternalReference(ref, binaryContent)).toBe(true);
    });

    it('should verify large content correctly', () => {
      // 100KB of data
      const largeContent = new Uint8Array(100 * 1024);
      for (let i = 0; i < largeContent.length; i++) {
        largeContent[i] = i % 256;
      }
      const ref = createExternalReference(largeContent, 'application/octet-stream');
      
      expect(verifyExternalReference(ref, largeContent)).toBe(true);
    });

    it('should handle reference created with urls', () => {
      const content = new TextEncoder().encode('test');
      const ref = createExternalReference(content, 'text/plain', ['https://example.com/file.txt']);
      
      // URLs shouldn't affect verification
      expect(verifyExternalReference(ref, content)).toBe(true);
    });

    it('should handle manually constructed reference', () => {
      const content = new TextEncoder().encode('test');
      const digest = computeDigestMultibase(content);
      
      // Manually construct reference (simulating receiving from external source)
      const ref = {
        digestMultibase: digest,
        mediaType: 'text/plain',
        url: ['https://example.com/file.txt'],
      };
      
      expect(verifyExternalReference(ref, content)).toBe(true);
    });

    it('should return false for invalid digest format', () => {
      const content = new TextEncoder().encode('test');
      
      // Invalid reference with bad digest
      const invalidRef = {
        digestMultibase: 'invalid-not-a-real-digest',
        mediaType: 'text/plain',
      };
      
      const isValid = verifyExternalReference(invalidRef, content);
      expect(isValid).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('should create and verify in round-trip', () => {
      const content = new TextEncoder().encode('round trip test');
      
      // Create reference
      const ref = createExternalReference(content, 'text/plain', ['https://example.com/test.txt']);
      
      // Verify the same content
      expect(verifyExternalReference(ref, content)).toBe(true);
      
      // Verify different content fails
      const different = new TextEncoder().encode('different');
      expect(verifyExternalReference(ref, different)).toBe(false);
    });

    it('should serialize and deserialize reference correctly', () => {
      const content = new TextEncoder().encode('serialization test');
      const ref = createExternalReference(content, 'image/png', ['https://example.com/image.png']);
      
      // Simulate JSON serialization (as would happen in event log)
      const json = JSON.stringify(ref);
      const parsed = JSON.parse(json);
      
      // Should still verify correctly
      expect(verifyExternalReference(parsed, content)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle unicode content', () => {
      const content = new TextEncoder().encode('Hello 世界 🌍');
      const ref = createExternalReference(content, 'text/plain; charset=utf-8');
      
      expect(verifyExternalReference(ref, content)).toBe(true);
    });

    it('should handle content with null bytes', () => {
      const content = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
      const ref = createExternalReference(content, 'application/octet-stream');
      
      expect(verifyExternalReference(ref, content)).toBe(true);
    });

    it('should be case-sensitive for media types', () => {
      const content = new TextEncoder().encode('test');
      
      const ref1 = createExternalReference(content, 'text/plain');
      const ref2 = createExternalReference(content, 'TEXT/PLAIN');
      
      // Media types are stored as provided (case matters)
      expect(ref1.mediaType).toBe('text/plain');
      expect(ref2.mediaType).toBe('TEXT/PLAIN');
      
      // But both should still verify correctly
      expect(verifyExternalReference(ref1, content)).toBe(true);
      expect(verifyExternalReference(ref2, content)).toBe(true);
    });
  });
});
