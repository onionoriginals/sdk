/**
 * CEL Hash Utilities
 * 
 * Computes and verifies Multibase-encoded Multihash digests as specified
 * in the CEL specification for external references.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { multibase } from '../utils/encoding';

/**
 * Computes a CEL-compliant digestMultibase from content.
 * 
 * Uses sha2-256 hash algorithm and encodes as Multibase base64url-nopad (prefix 'u').
 * 
 * @param content - The raw bytes to hash
 * @returns Multibase-encoded digest string (e.g., "uEiDm9F...")
 * 
 * @example
 * ```typescript
 * const digest = computeDigestMultibase(new TextEncoder().encode("hello"));
 * // Returns: "uLCA..."
 * ```
 */
export function computeDigestMultibase(content: Uint8Array): string {
  // Compute SHA-256 hash
  const hash = sha256(content);
  
  // Encode as Multibase base64url-nopad (prefix 'u')
  return multibase.encode(hash, 'base64url');
}

/**
 * Verifies that content matches a given digestMultibase.
 * 
 * @param content - The raw bytes to verify
 * @param digest - The expected digestMultibase string
 * @returns True if the content hash matches the digest, false otherwise
 * 
 * @example
 * ```typescript
 * const content = new TextEncoder().encode("hello");
 * const digest = computeDigestMultibase(content);
 * const isValid = verifyDigestMultibase(content, digest); // true
 * ```
 */
export function verifyDigestMultibase(content: Uint8Array, digest: string): boolean {
  try {
    // Compute hash of content
    const computedDigest = computeDigestMultibase(content);
    
    // Compare with expected digest
    return computedDigest === digest;
  } catch {
    // Invalid digest format or encoding error
    return false;
  }
}

/**
 * Decodes a digestMultibase string back to raw hash bytes.
 * 
 * @param digest - The Multibase-encoded digest string
 * @returns The raw SHA-256 hash bytes
 * @throws Error if the digest is not a valid Multibase base64url string
 */
export function decodeDigestMultibase(digest: string): Uint8Array {
  return multibase.decode(digest);
}
