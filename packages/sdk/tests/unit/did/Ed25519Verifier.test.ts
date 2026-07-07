import { describe, test, expect, beforeAll } from 'bun:test';
import { Ed25519Verifier } from '../../../src/did/Ed25519Verifier';
import { multikey } from '../../../src/crypto/Multikey';
import { signAsync, getPublicKeyAsync } from '@noble/ed25519';

describe('Ed25519Verifier', () => {
  // Test data - valid Ed25519 key pair
  const privateKey = new Uint8Array(32);
  privateKey.fill(1); // Simple test key

  let publicKey32Bytes: Uint8Array;
  let publicKey33Bytes: Uint8Array;

  const verificationMethodId = 'did:example:123#key-1';
  const message = new TextEncoder().encode('test message');

  // Initialize the public key before all tests
  beforeAll(async () => {
    publicKey32Bytes = await getPublicKeyAsync(privateKey);

    // Public key with version byte prefix (33 bytes)
    publicKey33Bytes = new Uint8Array(33);
    publicKey33Bytes[0] = 0x00; // version byte
    publicKey33Bytes.set(publicKey32Bytes, 1);
  });

  describe('constructor', () => {
    test('creates verifier without parameters', () => {
      const verifier = new Ed25519Verifier();
      expect(verifier).toBeDefined();
      expect(verifier.getVerificationMethodId()).toBeUndefined();
      expect(verifier.getPublicKey()).toBeUndefined();
    });

    test('creates verifier with verificationMethodId only', () => {
      const verifier = new Ed25519Verifier(verificationMethodId);
      expect(verifier.getVerificationMethodId()).toBe(verificationMethodId);
      expect(verifier.getPublicKey()).toBeUndefined();
    });

    test('creates verifier with both parameters', () => {
      const verifier = new Ed25519Verifier(verificationMethodId, publicKey32Bytes);
      expect(verifier.getVerificationMethodId()).toBe(verificationMethodId);
      expect(verifier.getPublicKey()).toEqual(publicKey32Bytes);
    });

    test('creates verifier with publicKey only', () => {
      const verifier = new Ed25519Verifier(undefined, publicKey32Bytes);
      expect(verifier.getVerificationMethodId()).toBeUndefined();
      expect(verifier.getPublicKey()).toEqual(publicKey32Bytes);
    });
  });

  describe('verify()', () => {
    test('verifies valid signature with 32-byte public key', async () => {
      const verifier = new Ed25519Verifier();
      const signature = await signAsync(message, privateKey);
      const result = await verifier.verify(signature, message, publicKey32Bytes);
      expect(result).toBe(true);
    });

    test('rejects a 33-byte public key instead of guessing at a prefix (issue #352)', async () => {
      // 33 bytes is the shape of a compressed secp256k1 key, not a "prefixed
      // Ed25519 key" (Ed25519 multicodec prefixes are 2 bytes → 34 bytes).
      const verifier = new Ed25519Verifier();
      const signature = await signAsync(message, privateKey);
      const result = await verifier.verify(signature, message, publicKey33Bytes);
      expect(result).toBe(false);
    });

    test('rejects invalid signature', async () => {
      const verifier = new Ed25519Verifier();
      const signature = await signAsync(message, privateKey);
      const wrongMessage = new TextEncoder().encode('wrong message');
      const result = await verifier.verify(signature, wrongMessage, publicKey32Bytes);
      expect(result).toBe(false);
    });

    test('rejects invalid public key length (too short)', async () => {
      const verifier = new Ed25519Verifier();
      const signature = await signAsync(message, privateKey);
      const invalidKey = new Uint8Array(16); // Too short
      const result = await verifier.verify(signature, message, invalidKey);
      expect(result).toBe(false);
    });

    test('rejects invalid public key length (too long)', async () => {
      const verifier = new Ed25519Verifier();
      const signature = await signAsync(message, privateKey);
      const invalidKey = new Uint8Array(64); // Too long
      const result = await verifier.verify(signature, message, invalidKey);
      expect(result).toBe(false);
    });

    test('handles verification errors gracefully', async () => {
      const verifier = new Ed25519Verifier();
      const invalidSignature = new Uint8Array(32); // Invalid signature (wrong length)
      const result = await verifier.verify(invalidSignature, message, publicKey32Bytes);
      expect(result).toBe(false);
    });

    test('verifies signature with different publicKey than constructor', async () => {
      const differentPublicKey = new Uint8Array(32);
      differentPublicKey.fill(2);
      const verifier = new Ed25519Verifier(verificationMethodId, differentPublicKey);

      // Should use the publicKey parameter, not constructor's publicKey
      const signature = await signAsync(message, privateKey);
      const result = await verifier.verify(signature, message, publicKey32Bytes);
      expect(result).toBe(true);
    });
  });

  describe('getVerificationMethodId()', () => {
    test('returns verificationMethodId when set', () => {
      const verifier = new Ed25519Verifier(verificationMethodId);
      expect(verifier.getVerificationMethodId()).toBe(verificationMethodId);
    });

    test('returns undefined when not set', () => {
      const verifier = new Ed25519Verifier();
      expect(verifier.getVerificationMethodId()).toBeUndefined();
    });
  });

  describe('getPublicKey()', () => {
    test('returns publicKey when set', () => {
      const verifier = new Ed25519Verifier(verificationMethodId, publicKey32Bytes);
      expect(verifier.getPublicKey()).toEqual(publicKey32Bytes);
    });

    test('returns undefined when not set', () => {
      const verifier = new Ed25519Verifier();
      expect(verifier.getPublicKey()).toBeUndefined();
    });
  });

  describe('getPublicKeyMultibase()', () => {
    test('returns a spec-compliant Ed25519 Multikey when set', () => {
      const verifier = new Ed25519Verifier(verificationMethodId, publicKey32Bytes);
      const encoded = verifier.getPublicKeyMultibase();
      expect(encoded).toBeDefined();
      expect(encoded?.startsWith('z')).toBe(true);

      // Round-trips through the Multikey decoder (multicodec header + base58btc)
      const decoded = multikey.decodePublicKey(encoded!);
      expect(decoded.type).toBe('Ed25519');
      expect(decoded.key).toEqual(publicKey32Bytes);
    });

    test('returns undefined when publicKey not set', () => {
      const verifier = new Ed25519Verifier();
      expect(verifier.getPublicKeyMultibase()).toBeUndefined();
    });

    test('returns undefined when only verificationMethodId is set', () => {
      const verifier = new Ed25519Verifier(verificationMethodId);
      expect(verifier.getPublicKeyMultibase()).toBeUndefined();
    });

    test('throws for a wrong-length key instead of minting a wrong multikey (issue #352)', () => {
      const verifier = new Ed25519Verifier(verificationMethodId, publicKey33Bytes);
      expect(() => verifier.getPublicKeyMultibase()).toThrow(/expected 32 bytes/);
    });
  });
});
