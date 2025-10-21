/**
 * Turnkey Signer - Integration between Turnkey key management and didwebvh-ts
 *
 * This module provides a custom signer implementation that works with Turnkey-managed
 * keys while maintaining compatibility with the didwebvh-ts library.
 */

import { Turnkey } from "@turnkey/sdk-server";
import { ExternalSigner, ExternalVerifier } from "@originals/sdk";
import { multikey } from "@originals/sdk";
import { bytesToHex } from "./key-utils";
import { sha512 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import * as ed25519 from '@noble/ed25519';

// Configure @noble/ed25519 with required SHA-512 function
const sha512Fn = (...msgs: Uint8Array[]) => sha512(concatBytes(...msgs));

// Initialize Ed25519 configuration
try {
  const ed25519Module = ed25519 as any;
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
 * Turnkey-based signer for DID:WebVH operations
 * Implements the ExternalSigner interface for use with the Originals SDK
 */
export class TurnkeyWebVHSigner implements ExternalSigner, ExternalVerifier {
  private privateKeyId: string;
  private publicKeyMultibase: string;
  private turnkeyClient: Turnkey;
  private verificationMethodId: string;
  private organizationId: string;

  constructor(
    privateKeyId: string,
    publicKeyMultibase: string,
    turnkeyClient: Turnkey,
    verificationMethodId: string,
    organizationId: string
  ) {
    this.privateKeyId = privateKeyId;
    this.publicKeyMultibase = publicKeyMultibase;
    this.turnkeyClient = turnkeyClient;
    this.verificationMethodId = verificationMethodId;
    this.organizationId = organizationId;
  }

  /**
   * Sign data using Turnkey's signing API
   * @param input - The signing input containing document and proof
   * @returns The proof value (multibase-encoded signature)
   */
  async sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>
  }): Promise<{ proofValue: string }> {
    try {
      // Import didwebvh-ts to use its canonical data preparation
      const { prepareDataForSigning } = await import('didwebvh-ts');

      // Prepare the data for signing using didwebvh-ts's canonical approach
      const dataToSign = await prepareDataForSigning(input.document, input.proof);

      // Convert canonical data to hex format for Turnkey's signRawPayload API
      const dataHex = bytesToHex(dataToSign);

      // Sign using Turnkey's API
      const signResponse = await this.turnkeyClient.apiClient().signRawPayload({
        signWith: this.privateKeyId,
        payload: dataHex,
        encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
        hashFunction: 'HASH_FUNCTION_NO_OP', // We're passing pre-hashed data
      });

      // Extract signature from response
      const signature = (signResponse.r || '') + (signResponse.s || '');

      if (!signature) {
        throw new Error('No signature returned from Turnkey');
      }

      // Convert signature to Buffer
      const signatureBytes = Buffer.from(signature, 'hex');

      // Ed25519 signatures should be exactly 64 bytes
      if (signatureBytes.length !== 64) {
        throw new Error(`Invalid Ed25519 signature length: ${signatureBytes.length} (expected 64 bytes)`);
      }

      // Encode signature as multibase and return
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
   * @param signature - The signature bytes
   * @param message - The message bytes that were signed
   * @param publicKey - The public key bytes
   * @returns True if the signature is valid
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
        // Remove version byte prefix if present
        ed25519PublicKey = publicKey.slice(1);
      } else if (publicKey.length !== 32) {
        return false;
      }

      // Ensure sha512Sync is set
      if (typeof (ed25519 as any).utils?.sha512Sync !== 'function') {
        (ed25519 as any).utils.sha512Sync = sha512Fn;
      }

      return await ed25519.verify(signature, message, ed25519PublicKey);
    } catch (error) {
      console.error('Error verifying signature with Turnkey:', error);
      return false;
    }
  }

  /**
   * Get the verification method ID for this signer
   * Required by didwebvh-ts
   * @returns The verification method ID in did:key format
   */
  getVerificationMethodId(): string {
    return this.verificationMethodId;
  }

  /**
   * Get the public key in multibase format
   * @returns The public key multibase string
   */
  getPublicKeyMultibase(): string {
    return this.publicKeyMultibase;
  }
}

/**
 * Create a Turnkey signer for a user's private key
 * @param organizationId - The Turnkey organization/sub-organization ID
 * @param privateKeyId - The private key ID to use for signing
 * @param turnkeyClient - Initialized Turnkey client
 * @param verificationMethodId - The DID verification method ID
 * @returns A configured TurnkeyWebVHSigner
 */
export async function createTurnkeySigner(
  organizationId: string,
  privateKeyId: string,
  turnkeyClient: Turnkey,
  verificationMethodId: string
): Promise<TurnkeyWebVHSigner> {
  // Get private key details from Turnkey to extract public key
  const keyResponse = await turnkeyClient.apiClient().getPrivateKey({
    privateKeyId,
  });

  const publicKey = keyResponse.privateKey?.publicKey;
  if (!publicKey) {
    throw new Error(`Public key not found for private key: ${privateKeyId}`);
  }

  // Turnkey returns public keys in hex format
  // Convert to multibase for DID operations
  const publicKeyBytes = Buffer.from(publicKey, 'hex');

  // For Ed25519 keys, ensure we have the correct format
  let ed25519PublicKey = publicKeyBytes;
  if (publicKeyBytes.length === 33) {
    // Remove version byte if present
    ed25519PublicKey = publicKeyBytes.slice(1);
  }

  const publicKeyMultibase = multikey.encodePublicKey(ed25519PublicKey, 'Ed25519');

  return new TurnkeyWebVHSigner(
    privateKeyId,
    publicKeyMultibase,
    turnkeyClient,
    verificationMethodId,
    organizationId
  );
}

/**
 * Create verification methods for a user's Turnkey wallets
 * @param organizationId - The Turnkey sub-organization ID for the user
 * @param turnkeyClient - Initialized Turnkey client
 * @param domain - The domain for the DID
 * @param userSlug - The user slug for the DID
 * @returns Array of verification methods, update key, and key IDs
 */
export async function createVerificationMethodsFromTurnkey(
  organizationId: string,
  turnkeyClient: Turnkey,
  domain: string,
  userSlug: string
): Promise<{
  verificationMethods: Array<{
    type: string;
    publicKeyMultibase: string;
  }>;
  updateKey: string;
  authKeyId: string;
  updateKeyId: string;
}> {
  // List existing private keys for the organization
  const keysResponse = await turnkeyClient.apiClient().getPrivateKeys({});

  const existingKeys = keysResponse.privateKeys || [];

  let authKey, updateKey;

  // Check if we have existing keys
  const ed25519Keys = existingKeys.filter(
    (k: any) => k.curve === 'CURVE_ED25519' && k.addressFormats?.includes('ADDRESS_FORMAT_XLM')
  );

  if (ed25519Keys.length === 0) {
    // Create both keys
    const authKeyResponse = await turnkeyClient.apiClient().createPrivateKeys({
      privateKeys: [{
        privateKeyName: `auth-key-${userSlug}`,
        curve: 'CURVE_ED25519',
        addressFormats: ['ADDRESS_FORMAT_XLM'],
        privateKeyTags: ['auth', 'did:webvh'],
      }],
    });

    const updateKeyResponse = await turnkeyClient.apiClient().createPrivateKeys({
      privateKeys: [{
        privateKeyName: `update-key-${userSlug}`,
        curve: 'CURVE_ED25519',
        addressFormats: ['ADDRESS_FORMAT_XLM'],
        privateKeyTags: ['update', 'did:webvh'],
      }],
    });

    authKey = authKeyResponse.privateKeys?.[0];
    updateKey = updateKeyResponse.privateKeys?.[0];
  } else if (ed25519Keys.length === 1) {
    // Use existing key for auth, create one for updates
    authKey = ed25519Keys[0];

    const updateKeyResponse = await turnkeyClient.apiClient().createPrivateKeys({
      privateKeys: [{
        privateKeyName: `update-key-${userSlug}`,
        curve: 'CURVE_ED25519',
        addressFormats: ['ADDRESS_FORMAT_XLM'],
        privateKeyTags: ['update', 'did:webvh'],
      }],
    });

    updateKey = updateKeyResponse.privateKeys?.[0];
  } else {
    // Use existing keys
    authKey = ed25519Keys[0];
    updateKey = ed25519Keys[1];
  }

  if (!authKey || !updateKey) {
    throw new Error('Failed to create or retrieve keys from Turnkey');
  }

  const authKeyId = authKey?.privateKeyId || '';
  const updateKeyId = updateKey?.privateKeyId || '';

  if (!authKeyId || !updateKeyId) {
    throw new Error('Private key IDs not available from Turnkey');
  }

  // Fetch full key details to get public keys
  const authKeyDetails = await turnkeyClient.apiClient().getPrivateKey({
    privateKeyId: authKeyId,
  });
  const updateKeyDetails = await turnkeyClient.apiClient().getPrivateKey({
    privateKeyId: updateKeyId,
  });

  const authPublicKeyHex = authKeyDetails.privateKey?.publicKey || '';
  const updatePublicKeyHex = updateKeyDetails.privateKey?.publicKey || '';

  if (!authPublicKeyHex || !updatePublicKeyHex) {
    throw new Error('Public keys not available from Turnkey');
  }

  const authPublicKeyBytes = Buffer.from(authPublicKeyHex, 'hex');
  const updatePublicKeyBytes = Buffer.from(updatePublicKeyHex, 'hex');

  // Remove version byte if present (handle 33-byte keys)
  const authKeyProcessed = authPublicKeyBytes.length === 33
    ? authPublicKeyBytes.slice(1)
    : authPublicKeyBytes;
  const updateKeyProcessed = updatePublicKeyBytes.length === 33
    ? updatePublicKeyBytes.slice(1)
    : updatePublicKeyBytes;

  const authKeyMultibase = multikey.encodePublicKey(authKeyProcessed, 'Ed25519');
  const updateKeyMultibase = multikey.encodePublicKey(updateKeyProcessed, 'Ed25519');

  return {
    verificationMethods: [
      {
        type: 'Multikey',
        publicKeyMultibase: authKeyMultibase,
      }
    ],
    updateKey: `did:key:${updateKeyMultibase}`,
    authKeyId,
    updateKeyId,
  };
}
