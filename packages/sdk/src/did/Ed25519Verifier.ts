import { verifyAsync } from '@noble/ed25519';
import type { ExternalVerifier } from '../types/common.js';
import { multikey } from '../crypto/Multikey.js';

/**
 * Ed25519Verifier - A simple Ed25519 verifier for DID operations
 * Compatible with didwebvh-ts resolveDIDFromLog
 */
export class Ed25519Verifier implements ExternalVerifier {
  private verificationMethodId?: string;
  private publicKey?: Uint8Array;

  constructor(verificationMethodId?: string, publicKey?: Uint8Array) {
    this.verificationMethodId = verificationMethodId;
    this.publicKey = publicKey;
  }

  /**
   * Verify a signature using Ed25519
   * @param signature - The signature bytes
   * @param message - The message bytes that were signed
   * @param publicKey - The public key bytes (can be different from constructor publicKey)
   * @returns True if the signature is valid
   */
  async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
    try {
      // Ed25519 public keys must be exactly 32 bytes. A 33-byte input is NOT
      // a "prefixed Ed25519 key": Ed25519 multicodec prefixes are 2 bytes
      // (0xed 0x01 → 34 bytes), while 33 bytes is the shape of a compressed
      // secp256k1 key. Stripping one byte verified against garbage — reject
      // instead of guessing (issue #352).
      if (publicKey.length !== 32) {
        console.error(`[Ed25519Verifier] Invalid public key length: ${publicKey.length} (expected 32 bytes)`);
        return false;
      }

      // Correct parameter order: verifyAsync(signature, message, publicKey)
      return await verifyAsync(signature, message, publicKey);
    } catch (error) {
      console.error('[Ed25519Verifier] Verification error:', error);
      return false;
    }
  }

  /**
   * Get the verification method ID associated with this verifier
   */
  getVerificationMethodId(): string | undefined {
    return this.verificationMethodId;
  }

  /**
   * Get the public key as Uint8Array
   */
  getPublicKey(): Uint8Array | undefined {
    return this.publicKey;
  }

  /**
   * Get the public key as a spec-compliant Ed25519 Multikey
   * (base58btc multibase with the ed25519-pub multicodec header).
   */
  getPublicKeyMultibase(): string | undefined {
    if (!this.publicKey) {
      return undefined;
    }
    // Silently slicing a "prefix" off a wrong-length key would mint a
    // well-formed-looking but wrong multikey (see verify(), issue #352).
    if (this.publicKey.length !== 32) {
      throw new Error(`Invalid Ed25519 public key length: ${this.publicKey.length} (expected 32 bytes)`);
    }
    return multikey.encodePublicKey(this.publicKey, 'Ed25519');
  }
}

