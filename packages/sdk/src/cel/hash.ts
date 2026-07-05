/**
 * CEL Hash Utilities
 * 
 * Computes and verifies Multibase-encoded Multihash digests as specified
 * in the CEL specification for external references.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { multibase } from '../utils/encoding.js';

/**
 * Multihash header for a sha2-256 digest: 0x12 = sha2-256 multicodec code,
 * 0x20 = digest length (32 bytes). A spec-conformant CEL digestMultibase is a
 * Multibase-encoded *Multihash*, not a bare hash — see types.ts.
 */
const SHA2_256_MULTIHASH_PREFIX = Uint8Array.from([0x12, 0x20]);

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

  // Prepend the sha2-256 multihash header (0x12 0x20) so the value is a
  // spec-conformant Multibase-encoded Multihash (e.g. "uEiD...") rather than a
  // bare digest ("uL..."). Bare digests are self-consistent but a
  // spec-conformant CEL implementation computes different previousEvent chain
  // links and external-reference digests, so it would reject these chains.
  const multihash = new Uint8Array(SHA2_256_MULTIHASH_PREFIX.length + hash.length);
  multihash.set(SHA2_256_MULTIHASH_PREFIX, 0);
  multihash.set(hash, SHA2_256_MULTIHASH_PREFIX.length);

  // Encode as Multibase base64url-nopad (prefix 'u')
  return multibase.encode(multihash, 'base64url');
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
    const expected = decodeDigestMultibase(digest);
    const actual = sha256(content);
    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= expected[i] ^ actual[i];
    return diff === 0;
  } catch {
    // Invalid digest format or encoding error
    return false;
  }
}

/**
 * Compares two digestMultibase strings for equality of the underlying
 * sha2-256 digest, tolerating a mix of the spec-conformant multihash form
 * and the legacy bare-digest form (see decodeDigestMultibase).
 *
 * @returns True iff both values decode to the same 32-byte digest
 */
export function digestMultibaseEquals(a: string, b: string): boolean {
  try {
    const da = decodeDigestMultibase(a);
    const db = decodeDigestMultibase(b);
    if (da.length !== db.length) return false;
    let diff = 0;
    for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
    return diff === 0;
  } catch {
    return false;
  }
}

/**
 * Decodes a digestMultibase string back to raw hash bytes.
 * 
 * @param digest - The Multibase-encoded digest string
 * @returns The raw SHA-256 hash bytes (the multihash header stripped)
 * @throws Error if the digest is not a valid Multibase base64url string or is
 *   not a sha2-256 multihash
 */
export function decodeDigestMultibase(digest: string): Uint8Array {
  const bytes = multibase.decode(digest);
  // Spec-conformant form: sha2-256 multihash header + 32-byte digest.
  if (
    bytes.length === SHA2_256_MULTIHASH_PREFIX.length + 32 &&
    bytes[0] === SHA2_256_MULTIHASH_PREFIX[0] &&
    bytes[1] === SHA2_256_MULTIHASH_PREFIX[1]
  ) {
    return bytes.slice(SHA2_256_MULTIHASH_PREFIX.length);
  }
  // Legacy bare-digest form emitted by SDK releases before the #258 multihash
  // fix. Logs anchored on Bitcoin in that format are immutable and cannot be
  // recomputed, so reads must keep accepting it; only computeDigestMultibase
  // (the write path) is multihash-only.
  if (bytes.length === 32) {
    return bytes;
  }
  throw new Error('Invalid digestMultibase: expected a Multibase-encoded sha2-256 multihash (or legacy 32-byte bare digest)');
}
