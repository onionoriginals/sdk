/**
 * Turnkey DID Signer Adapter
 * Adapts Turnkey signing to work with didwebvh-ts signer interface
 * Uses @turnkey/sdk-server for all Turnkey operations (no viem/ethers dependency)
 */

import { Turnkey } from '@turnkey/sdk-server';
import { OriginalsSDK, encoding } from '@originals/sdk';
import type { TurnkeyWalletAccount } from '../types';
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
  private turnkeyClient: Turnkey;
  private signWith: string;
  private subOrgId: string;
  private publicKeyMultibase: string;
  private onExpired?: () => void;

  constructor(
    turnkeyClient: Turnkey,
    signWith: string,
    subOrgId: string,
    publicKeyMultibase: string,
    onExpired?: () => void
  ) {
    this.turnkeyClient = turnkeyClient;
    this.signWith = signWith;
    this.subOrgId = subOrgId;
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

        // Sign with Turnkey via server SDK
        const result = await this.turnkeyClient.apiClient().signRawPayload({
          organizationId: this.subOrgId,
          signWith: this.signWith,
          payload: Buffer.from(dataToSign).toString('hex'),
          encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
          hashFunction: 'HASH_FUNCTION_NO_OP',
        });

        const r = result.r;
        const s = result.s;

        if (!r || !s) {
          throw new Error('Invalid signature response from Turnkey');
        }

        // For Ed25519, combine r+s only (64 bytes total)
        const cleanR = r.startsWith('0x') ? r.slice(2) : r;
        const cleanS = s.startsWith('0x') ? s.slice(2) : s;
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
  turnkeyClient: Turnkey;
  updateKeyAccount: TurnkeyWalletAccount;
  subOrgId: string;
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
    subOrgId,
    authKeyPublic,
    assertionKeyPublic,
    updateKeyPublic,
    domain,
    slug,
    onExpired,
  } = params;

  // Create Turnkey signer for the update key
  const signer = new TurnkeyDIDSigner(
    turnkeyClient,
    updateKeyAccount.address,
    subOrgId,
    updateKeyPublic,
    onExpired
  );

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
