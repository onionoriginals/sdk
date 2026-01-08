/**
 * Turnkey DID Signer Adapter
 * Adapts Turnkey signing to work with didwebvh-ts signer interface
 */

import { TurnkeyClient, WalletAccount } from '@turnkey/core';
import { OriginalsSDK, encoding } from '@originals/sdk';
import { TurnkeySessionExpiredError, withTokenExpiration } from './turnkey-client';

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
   */
  async sign(input: SigningInput): Promise<SigningOutput> {
    return withTokenExpiration(async () => {
      try {
        // Use SDK's prepareDIDDataForSigning
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

        // For Ed25519, combine r+s only (64 bytes total)
        const cleanR = response.r.startsWith('0x') ? response.r.slice(2) : response.r;
        const cleanS = response.s.startsWith('0x') ? response.s.slice(2) : response.s;
        const combinedHex = cleanR + cleanS;

        const signatureBytes = Buffer.from(combinedHex, 'hex');

        if (signatureBytes.length !== 64) {
          throw new Error(
            `Invalid Ed25519 signature length: ${signatureBytes.length} (expected 64 bytes)`
          );
        }

        const proofValue = encoding.multibase.encode(signatureBytes, 'base58btc');

        return { proofValue };
      } catch (error) {
        console.error('[TurnkeyDIDSigner] Error signing with Turnkey:', error);

        const errorStr = JSON.stringify(error);
        if (
          errorStr.toLowerCase().includes('api_key_expired') ||
          errorStr.toLowerCase().includes('expired api key') ||
          errorStr.toLowerCase().includes('"code":16')
        ) {
          console.warn('Detected expired API key in sign method, calling onExpired');
          if (this.onExpired) {
            this.onExpired();
          }
          throw new TurnkeySessionExpiredError();
        }

        throw error;
      }
    }, this.onExpired);
  }

  /**
   * Get the verification method ID for this signer
   */
  getVerificationMethodId(): string {
    return `did:key:${this.publicKeyMultibase}`;
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
  didDocument: unknown;
  didLog: unknown;
}> {
  const {
    turnkeyClient,
    updateKeyAccount,
    authKeyPublic,
    assertionKeyPublic,
    updateKeyPublic,
    domain,
    slug,
    onExpired,
  } = params;

  // Create Turnkey signer for the update key
  const signer = new TurnkeyDIDSigner(turnkeyClient, updateKeyAccount, updateKeyPublic, onExpired);

  // Use SDK's createDIDOriginal
  const result = await OriginalsSDK.createDIDOriginal({
    type: 'did',
    domain,
    signer,
    verifier: signer,
    updateKeys: [signer.getVerificationMethodId()],
    verificationMethods: [
      {
        id: '#key-0',
        type: 'Multikey',
        controller: '',
        publicKeyMultibase: authKeyPublic,
      },
      {
        id: '#key-1',
        type: 'Multikey',
        controller: '',
        publicKeyMultibase: assertionKeyPublic,
      },
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







