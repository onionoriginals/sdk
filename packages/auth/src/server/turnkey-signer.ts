/**
 * Turnkey Signer - Integration between Turnkey key management and Originals SDK
 *
 * Provides an ExternalSigner implementation that works with Turnkey-managed
 * keys for use with the Originals SDK's DID creation and signing operations.
 */

import { Turnkey } from '@turnkey/sdk-server';
import { ExternalSigner, ExternalVerifier, multikey, OriginalsSDK } from '@originals/sdk';
import { sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, bytesToHex } from '@noble/hashes/utils.js';
import * as ed25519 from '@noble/ed25519';

// Configure @noble/ed25519 with required SHA-512 function
const sha512Fn = (...msgs: Uint8Array[]): Uint8Array => sha512(concatBytes(...msgs));

// Initialize Ed25519 configuration
try {
  const ed25519Module = ed25519 as unknown as {
    utils?: { sha512Sync?: typeof sha512Fn };
    etc?: { sha512Sync?: typeof sha512Fn };
  };
  if (ed25519Module.utils) {
    ed25519Module.utils.sha512Sync = sha512Fn;
  }
  if (ed25519Module.etc) {
    ed25519Module.etc.sha512Sync = sha512Fn;
  }
} catch (error) {
  console.warn('Failed to configure ed25519 utils:', error);
}

/**
 * Turnkey-based signer for use with Originals SDK
 * Implements the ExternalSigner and ExternalVerifier interfaces
 */
export class TurnkeyWebVHSigner implements ExternalSigner, ExternalVerifier {
  private subOrgId: string;
  private keyId: string;
  private publicKeyMultibase: string;
  private turnkeyClient: Turnkey;
  private verificationMethodId: string;

  constructor(
    subOrgId: string,
    keyId: string,
    publicKeyMultibase: string,
    turnkeyClient: Turnkey,
    verificationMethodId: string
  ) {
    this.subOrgId = subOrgId;
    this.keyId = keyId;
    this.publicKeyMultibase = publicKeyMultibase;
    this.turnkeyClient = turnkeyClient;
    this.verificationMethodId = verificationMethodId;
  }

  /**
   * Sign data using Turnkey's API
   */
  async sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }> {
    try {
      // Prepare the data for signing using the SDK's canonical approach
      const dataToSign = await OriginalsSDK.prepareDIDDataForSigning(input.document, input.proof);

      // Convert canonical data to hex format for Turnkey's sign API
      const dataHex = `0x${bytesToHex(dataToSign)}`;

      // Sign using Turnkey's API
      const result = await this.turnkeyClient.apiClient().signRawPayload({
        organizationId: this.subOrgId,
        signWith: this.keyId,
        payload: dataHex,
        encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
        hashFunction: 'HASH_FUNCTION_NO_OP',
      });

      const signRawResult = result.activity?.result?.signRawPayloadResult;
      if (!signRawResult?.r || !signRawResult?.s) {
        throw new Error('No signature returned from Turnkey');
      }

      const signature = signRawResult.r + signRawResult.s;

      // Convert signature to bytes
      const cleanSig = signature.startsWith('0x') ? signature.slice(2) : signature;
      let signatureBytes = Buffer.from(cleanSig, 'hex');

      // Ed25519 signatures should be exactly 64 bytes
      if (signatureBytes.length === 65) {
        signatureBytes = signatureBytes.slice(0, 64);
      } else if (signatureBytes.length !== 64) {
        throw new Error(
          `Invalid Ed25519 signature length: ${signatureBytes.length} (expected 64 bytes)`
        );
      }

      // Encode signature as multibase
      const proofValue = multikey.encodeMultibase(signatureBytes);
      return { proofValue };
    } catch (error) {
      console.error('Error signing with Turnkey:', error);
      throw new Error(
        `Failed to sign with Turnkey: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Verify a signature
   */
  async verify(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array
  ): Promise<boolean> {
    try {
      // Ed25519 public keys must be exactly 32 bytes
      let ed25519PublicKey = publicKey;
      if (publicKey.length === 33) {
        ed25519PublicKey = publicKey.slice(1);
      } else if (publicKey.length !== 32) {
        return false;
      }

      const ed25519Module = ed25519 as unknown as {
        utils?: { sha512Sync?: typeof sha512Fn };
      };
      if (typeof ed25519Module.utils?.sha512Sync !== 'function') {
        ed25519Module.utils!.sha512Sync = sha512Fn;
      }

      return await ed25519.verifyAsync(signature, message, ed25519PublicKey);
    } catch (error) {
      console.error('Error verifying signature:', error);
      return false;
    }
  }

  getVerificationMethodId(): string {
    return this.verificationMethodId;
  }

  getPublicKeyMultibase(): string {
    return this.publicKeyMultibase;
  }
}

/**
 * Create a Turnkey signer for use with the Originals SDK
 */
export function createTurnkeySigner(
  subOrgId: string,
  keyId: string,
  turnkeyClient: Turnkey,
  verificationMethodId: string,
  publicKeyMultibase: string
): TurnkeyWebVHSigner {
  return new TurnkeyWebVHSigner(
    subOrgId,
    keyId,
    publicKeyMultibase,
    turnkeyClient,
    verificationMethodId
  );
}

