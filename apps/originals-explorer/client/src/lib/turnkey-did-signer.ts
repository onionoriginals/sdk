/**
 * Turnkey DID Signer Adapter
 * Adapts Turnkey signing to work with didwebvh-ts signer interface
 */

import { TurnkeyClient, WalletAccount } from '@turnkey/core';
import { withTokenExpiration, TurnkeySessionExpiredError } from './turnkey-error-handler';
import { OriginalsSDK, multikey } from '@originals/sdk';

interface SigningInput {
  document: Record<string, unknown>;
  proof: Record<string, unknown>;
}

interface SigningOutput {
  proofValue: string;
}

/**
 * Signer that uses Turnkey for signing DID documents
 * Compatible with didwebvh-ts signer interface
 */
export class TurnkeyDIDSigner {
  private turnkeyClient: TurnkeyClient;
  private walletAccount: WalletAccount;
  private publicKeyMultibase: string;
  private onExpired?: () => void;

  constructor(
    turnkeyClient: TurnkeyClient,
    walletAccount: WalletAccount,
    publicKeyMultibase: string,
    onExpired?: () => void
  ) {
    this.turnkeyClient = turnkeyClient;
    this.walletAccount = walletAccount;
    this.publicKeyMultibase = publicKeyMultibase;
    this.onExpired = onExpired;
  }

  /**
   * Sign the document and proof using Turnkey
   * This follows the didwebvh-ts signing pattern
   */
  async sign(input: SigningInput): Promise<SigningOutput> {
    return withTokenExpiration(async () => {
      try {
        // Use SDK's prepareDIDDataForSigning (which wraps didwebvh-ts's prepareDataForSigning)
        // This ensures didwebvh-ts is only imported within the SDK
        const dataToSign = await OriginalsSDK.prepareDIDDataForSigning(input.document, input.proof);

        // Convert to hex for Turnkey
        const hexData = Array.from(new Uint8Array(dataToSign))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        // Sign with Turnkey
        const response = await this.turnkeyClient.signMessage({
          organizationId: this.walletAccount.organizationId,
          walletAccount: this.walletAccount,
          message: hexData,
          encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
          hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
        });

        if (!response.r || !response.s) {
          throw new Error('Invalid signature response from Turnkey');
        }

        // For Ed25519, combine r+s only (64 bytes total), ignore v component
        const cleanR = response.r.startsWith('0x') ? response.r.slice(2) : response.r;
        const cleanS = response.s.startsWith('0x') ? response.s.slice(2) : response.s;
        const combinedHex = cleanR + cleanS;

        // Convert hex to bytes
        const signatureBytes = Buffer.from(combinedHex, 'hex');

        // Validate Ed25519 signature length (should be 64 bytes)
        if (signatureBytes.length !== 64) {
          throw new Error(`Invalid Ed25519 signature length: ${signatureBytes.length} (expected 64 bytes)`);
        }

        // Encode signature as multibase using SDK method
        const proofValue = multikey.encodeMultibase(signatureBytes);

        return { proofValue };
      } catch (error) {
        console.error('Error signing with Turnkey:', error);
        
        // Check error here too before re-throwing (backup in case withTokenExpiration doesn't catch it)
        const errorStr = JSON.stringify(error);
        if (errorStr.toLowerCase().includes('api_key_expired') || 
            errorStr.toLowerCase().includes('expired api key') ||
            errorStr.toLowerCase().includes('"code":16')) {
          console.warn('Detected expired API key in sign method, calling onExpired');
          if (this.onExpired) {
            this.onExpired();
          }
          throw new TurnkeySessionExpiredError('Your Turnkey session has expired. Please log in again.');
        }
        
        throw error;
      }
    }, this.onExpired);
  }

  /**
   * Get the verification method ID for this signer
   * didwebvh-ts expects did:key format
   */
  getVerificationMethodId(): string {
    return `did:key:${this.publicKeyMultibase}`;
  }

  /**
   * Verify a signature (required by didwebvh-ts Verifier interface)
   * Uses OriginalsSDK's verifyDIDSignature helper for browser-compatible verification
   * @param signature - The signature bytes
   * @param message - The message bytes that were signed
   * @param publicKey - The public key bytes
   * @returns True if the signature is valid
   */
  async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
    try {
      // Use SDK's static helper method for verification
      return await OriginalsSDK.verifyDIDSignature(signature, message, publicKey);
    } catch (error) {
      console.error('Error verifying signature:', error);
      return false;
    }
  }

  /**
   * Format Turnkey signature (r, s, v) into multibase format expected by didwebvh-ts
   */
  private formatSignatureForMultibase(r: string, s: string, v?: string): string {
    // Remove '0x' prefix if present
    const cleanR = r.startsWith('0x') ? r.slice(2) : r;
    const cleanS = s.startsWith('0x') ? s.slice(2) : s;

    // Combine r and s
    let combined = cleanR + cleanS;

    // Add v if present
    if (v) {
      const cleanV = v.startsWith('0x') ? v.slice(2) : v;
      combined += cleanV;
    }

    // Convert hex to bytes
    const bytes = new Uint8Array(combined.length / 2);
    for (let i = 0; i < combined.length; i += 2) {
      bytes[i / 2] = parseInt(combined.substring(i, i + 2), 16);
    }

    // Encode as multibase (base58btc with 'z' prefix)
    return 'z' + this.base58Encode(bytes);
  }

  /**
   * Encode bytes as base58 (Bitcoin alphabet)
   */
  private base58Encode(bytes: Uint8Array): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const BASE = 58n;

    // Convert bytes to big number
    let num = 0n;
    for (const byte of bytes) {
      num = num * 256n + BigInt(byte);
    }

    // Convert to base58
    const result: string[] = [];
    while (num > 0n) {
      const remainder = Number(num % BASE);
      result.unshift(ALPHABET[remainder]);
      num = num / BASE;
    }

    // Add leading '1's for leading zero bytes
    for (const byte of bytes) {
      if (byte === 0) {
        result.unshift('1');
      } else {
        break;
      }
    }

    return result.join('');
  }
}

/**
 * Create a DID:WebVH using OriginalsSDK.createDIDOriginal() with Turnkey signing
 */
export async function createDIDWithTurnkey(params: {
  turnkeyClient: TurnkeyClient;
  updateKeyAccount: WalletAccount;
  authKeyPublic: string;
  assertionKeyPublic: string;
  updateKeyPublic: string;
  domain: string;
  slug: string;
  onExpired?: () => void;
}): Promise<{
  did: string;
  didDocument: any;
  didLog: any;
}> {
  const { turnkeyClient, updateKeyAccount, authKeyPublic, assertionKeyPublic, updateKeyPublic, domain, slug, onExpired } = params;

  // Create Turnkey signer for the update key
  const signer = new TurnkeyDIDSigner(turnkeyClient, updateKeyAccount, updateKeyPublic, onExpired);

  // Use SDK's createDIDOriginal which wraps didwebvh-ts's createDID
  // Pass signer as both signer and verifier since TurnkeyDIDSigner implements both interfaces
  const result = await OriginalsSDK.createDIDOriginal({
    type: 'did',
    domain,
    signer,
    verifier: signer, // Explicitly pass signer as verifier since it implements verify()
    updateKeys: [signer.getVerificationMethodId()],
    verificationMethods: [
      {
        id: '#key-0',
        type: 'Multikey',
        controller: '', // Will be set by createDID
        publicKeyMultibase: authKeyPublic,
      },
      {
        id: '#key-1',
        type: 'Multikey',
        controller: '', // Will be set by createDID
        publicKeyMultibase: assertionKeyPublic,
      }
    ],
    paths: [slug],
    portable: false,
    authentication: ['#key-0'],
    assertionMethod: ['#key-1'],
  });

  return {
    did: result.did,
    didDocument: result.doc,
    didLog: result.log,
  };
}
