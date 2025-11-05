import { verifyAsync } from '@noble/ed25519';
import type { ExternalVerifier } from '../types/common.js';

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
      // Ed25519 public keys must be exactly 32 bytes
      // Some keys may have a version byte prefix, so remove it if present
      let ed25519PublicKey = publicKey;
      if (publicKey.length === 33) {
        ed25519PublicKey = publicKey.slice(1);
      } else if (publicKey.length !== 32) {
        console.error(`[Ed25519Verifier] Invalid public key length: ${publicKey.length} (expected 32 bytes)`);
        return false;
      }
      
      // Correct parameter order: verifyAsync(signature, message, publicKey)
      return await verifyAsync(signature, message, ed25519PublicKey);
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
   * Get the public key in multibase format (base64url with 'z' prefix)
   */
  getPublicKeyMultibase(): string | undefined {
    if (!this.publicKey) {
      return undefined;
    }
    return `z${Buffer.from(this.publicKey).toString('base64')}`;
  }
}

