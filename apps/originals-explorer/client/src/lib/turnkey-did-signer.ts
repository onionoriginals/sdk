/**
 * Turnkey DID Signer Adapter
 * Adapts Turnkey signing to work with didwebvh-ts signer interface
 */

import { TurnkeyClient, WalletAccount } from '@turnkey/core';
import { withTokenExpiration, TurnkeySessionExpiredError } from './turnkey-error-handler';
import { OriginalsSDK, encoding } from '@originals/sdk';

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
        const dataToSign = await OriginalsSDK.prepareDIDDataForSigning(input.document, input.proof);
        
        // Sign with Turnkey
        const response = await this.turnkeyClient.httpClient.signRawPayload({
          signWith: this.walletAccount.address,
          payload: Buffer.from(dataToSign).toString('hex'),
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

        // Convert hex to bytes (use cleaned hex to avoid 0x prefix issues)
        const signatureBytes = Buffer.from(combinedHex, 'hex');

        // Validate Ed25519 signature length (should be 64 bytes)
        if (signatureBytes.length !== 64) {
          throw new Error(`Invalid Ed25519 signature length: ${signatureBytes.length} (expected 64 bytes)`);
        }

        // Encode signature as multibase using SDK method
        const proofValue = encoding.multibase.encode(signatureBytes, 'base58btc');

        return { proofValue };
      } catch (error) {
        console.error('[TurnkeyDIDSigner] Error signing with Turnkey:', error);

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
      console.error('[TurnkeyDIDSigner] Error verifying signature:', error);
      return false;
    }
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
