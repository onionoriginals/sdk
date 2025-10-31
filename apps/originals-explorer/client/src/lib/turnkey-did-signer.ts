/**
 * Turnkey DID Signer Adapter
 * Adapts Turnkey signing to work with didwebvh-ts signer interface
 */

import { TurnkeyClient, WalletAccount } from '@turnkey/core';
import { withTokenExpiration } from './turnkey-error-handler';

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
        // Import the prepareDataForSigning function from didwebvh-ts
        // This ensures we sign the data in the exact format didwebvh-ts expects
        const { prepareDataForSigning } = await import('didwebvh-ts');

        // Prepare the canonical data for signing
        const dataToSign = await prepareDataForSigning(input.document, input.proof);

        // Convert to hex for Turnkey
        const hexData = Array.from(dataToSign)
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

        // Combine r and s into the format expected by didwebvh-ts
        // didwebvh-ts expects multibase-encoded signature
        const signature = this.formatSignatureForMultibase(response.r, response.s, response.v);

        return { proofValue: signature };
      } catch (error) {
        console.error('Error signing with Turnkey:', error);
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
 * Create a DID:WebVH using didwebvh-ts with Turnkey signing
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

  // Import didwebvh-ts
  const { createDID } = await import('didwebvh-ts');

  // Create verification methods for auth and assertion keys
  const verificationMethods = [
    {
      type: 'Multikey',
      publicKeyMultibase: authKeyPublic,
    },
    {
      type: 'Multikey',
      publicKeyMultibase: assertionKeyPublic,
    }
  ];

  // Create the DID using didwebvh-ts
  const result = await createDID({
    domain,
    signer,
    verifier: signer, // Use same signer as verifier
    updateKeys: [signer.getVerificationMethodId()],
    verificationMethods,
    context: [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1'
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
