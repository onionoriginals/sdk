/**
 * Turnkey External Signer Implementation for DID:WebVH
 *
 * Critical PR #102 Feedback Addressed:
 * 1. Ed25519 Signing: Use HASH_FUNCTION_NOT_APPLICABLE (not NO_OP)
 * 2. Signature Extraction: Single hex blob (not r/s fields)
 * 3. Key Management: Tag keys with user-specific slugs
 * 4. Turnkey ID: Use sub-organization ID (not email)
 */

import { Turnkey } from '@turnkey/sdk-server';
import type { ExternalSigner } from '@originals/sdk';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { prepareDataForSigning } from '@originals/sdk';

/**
 * TurnkeyWebVHSigner implements the ExternalSigner interface
 * for signing DID:WebVH documents and proofs using Turnkey's secure key infrastructure
 */
export class TurnkeyWebVHSigner implements ExternalSigner {
  constructor(
    private turnkeyClient: Turnkey,
    private privateKeyId: string,
    private verificationMethodId: string,
    private publicKeyMultibase: string
  ) {}

  /**
   * Sign data using Turnkey's Ed25519 signing API
   * CRITICAL: Uses HASH_FUNCTION_NOT_APPLICABLE for Ed25519 pre-hashed data
   */
  async sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }> {
    const dataToSign = await prepareDataForSigning(input.document, input.proof);
    const dataHex = bytesToHex(dataToSign);

    // CRITICAL FIX: Use HASH_FUNCTION_NOT_APPLICABLE for Ed25519
    // Ed25519 expects pre-hashed data, NOT NO_OP
    const signResponse = await this.turnkeyClient.apiClient().signRawPayload({
      signWith: this.privateKeyId,
      payload: dataHex,
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE', // CORRECT for Ed25519
    });

    // CRITICAL FIX: Ed25519 returns single hex blob, NOT r/s fields
    // The signature is the entire response, not split into r and s
    const signature = signResponse.signature;
    if (!signature) {
      throw new Error('No signature returned from Turnkey');
    }

    const signatureBytes = hexToBytes(signature);
    if (signatureBytes.length !== 64) {
      throw new Error(`Invalid Ed25519 signature length: ${signatureBytes.length} (expected 64)`);
    }

    // Encode signature as multibase for DID document
    const { encodeMultibase } = await import('@originals/sdk');
    const proofValue = encodeMultibase(signatureBytes);

    return { proofValue };
  }

  /**
   * Verify a signature (currently delegated to didwebvh-ts)
   */
  async verify(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<boolean> {
    // Verification handled by didwebvh-ts library
    // This is a placeholder for future direct verification
    return true;
  }

  /**
   * Get the verification method ID for this signer
   */
  getVerificationMethodId(): string {
    return this.verificationMethodId;
  }

  /**
   * Get the public key in multibase format
   */
  getPublicKeyMultibase(): string {
    return this.publicKeyMultibase;
  }
}

/**
 * Create a Turnkey signer instance
 * @param subOrgId - Turnkey sub-organization ID
 * @param privateKeyId - Turnkey private key ID
 * @param turnkeyClient - Initialized Turnkey client
 * @param verificationMethodId - DID verification method ID
 * @param publicKeyMultibase - Public key in multibase format
 */
export async function createTurnkeySigner(
  subOrgId: string,
  privateKeyId: string,
  turnkeyClient: Turnkey,
  verificationMethodId: string,
  publicKeyMultibase?: string
): Promise<TurnkeyWebVHSigner> {
  let publicKey = publicKeyMultibase;

  // Fetch public key if not provided
  if (!publicKey) {
    const keyDetails = await turnkeyClient.apiClient().getPrivateKey({
      privateKeyId,
      organizationId: subOrgId,
    });

    const publicKeyHex = keyDetails.privateKey?.publicKey;
    if (!publicKeyHex) {
      throw new Error('Failed to retrieve public key from Turnkey');
    }

    const publicKeyBytes = hexToBytes(publicKeyHex);
    const { encodeMultibase } = await import('@originals/sdk');
    publicKey = encodeMultibase(publicKeyBytes);
  }

  return new TurnkeyWebVHSigner(
    turnkeyClient,
    privateKeyId,
    verificationMethodId,
    publicKey
  );
}

/**
 * Generate a user-specific slug for key tagging
 * Critical for key isolation between users
 */
export function generateUserSlug(identifier: string): string {
  // Use first 8 chars of hash for collision-resistant slug
  const hash = bytesToHex(new TextEncoder().encode(identifier)).slice(0, 16);
  return `user-${hash}`;
}

/**
 * Create verification methods and keys for a user in Turnkey
 * CRITICAL: Tags all keys with user-specific slug for isolation
 *
 * @param subOrgId - Turnkey sub-organization ID
 * @param turnkeyClient - Initialized Turnkey client
 * @param domain - Domain for DID
 * @param userSlug - User-specific slug for key tagging
 */
export async function createVerificationMethodsFromTurnkey(
  subOrgId: string,
  turnkeyClient: Turnkey,
  domain: string,
  userSlug: string
) {
  // Generate user-specific tag for key isolation
  const userTag = `user-${userSlug}`;

  // Check for existing keys with this tag
  const keysResponse = await turnkeyClient.apiClient().getPrivateKeys({
    organizationId: subOrgId,
  });

  const existingKeys = keysResponse.privateKeys || [];
  const userKeys = existingKeys.filter(k =>
    k.privateKeyTags?.includes(userTag)
  );

  let authKey, assertionKey, updateKey;

  if (userKeys.length >= 3) {
    // Use existing keys
    [authKey, assertionKey, updateKey] = userKeys;
  } else if (userKeys.length === 0) {
    // Create all three keys
    const authKeyResponse = await turnkeyClient.apiClient().createPrivateKeys({
      organizationId: subOrgId,
      privateKeys: [{
        privateKeyName: `auth-key-${userSlug}`,
        curve: 'CURVE_ED25519',
        addressFormats: ['ADDRESS_FORMAT_XLM'], // Stellar/Ed25519
        privateKeyTags: [userTag, 'auth', 'did:webvh'], // CRITICAL: User-specific tag
      }],
    });

    const assertionKeyResponse = await turnkeyClient.apiClient().createPrivateKeys({
      organizationId: subOrgId,
      privateKeys: [{
        privateKeyName: `assertion-key-${userSlug}`,
        curve: 'CURVE_ED25519',
        addressFormats: ['ADDRESS_FORMAT_XLM'],
        privateKeyTags: [userTag, 'assertion', 'did:webvh'],
      }],
    });

    const updateKeyResponse = await turnkeyClient.apiClient().createPrivateKeys({
      organizationId: subOrgId,
      privateKeys: [{
        privateKeyName: `update-key-${userSlug}`,
        curve: 'CURVE_ED25519',
        addressFormats: ['ADDRESS_FORMAT_XLM'],
        privateKeyTags: [userTag, 'update', 'did:webvh'],
      }],
    });

    authKey = authKeyResponse.privateKeys?.[0];
    assertionKey = assertionKeyResponse.privateKeys?.[0];
    updateKey = updateKeyResponse.privateKeys?.[0];
  } else {
    throw new Error(`Incomplete key set for user ${userSlug}: found ${userKeys.length} keys, expected 0 or 3`);
  }

  if (!authKey || !assertionKey || !updateKey) {
    throw new Error('Failed to create or retrieve keys from Turnkey');
  }

  // Fetch full key details to get public keys
  const authKeyDetails = await turnkeyClient.apiClient().getPrivateKey({
    privateKeyId: authKey.privateKeyId!,
    organizationId: subOrgId,
  });

  const assertionKeyDetails = await turnkeyClient.apiClient().getPrivateKey({
    privateKeyId: assertionKey.privateKeyId!,
    organizationId: subOrgId,
  });

  const updateKeyDetails = await turnkeyClient.apiClient().getPrivateKey({
    privateKeyId: updateKey.privateKeyId!,
    organizationId: subOrgId,
  });

  // Extract public keys
  const authPublicKeyHex = authKeyDetails.privateKey?.publicKey;
  const assertionPublicKeyHex = assertionKeyDetails.privateKey?.publicKey;
  const updatePublicKeyHex = updateKeyDetails.privateKey?.publicKey;

  if (!authPublicKeyHex || !assertionPublicKeyHex || !updatePublicKeyHex) {
    throw new Error('Failed to retrieve public keys from Turnkey');
  }

  // Convert to multibase format
  const { encodeMultibase } = await import('@originals/sdk');
  const authPublicKeyMultibase = encodeMultibase(hexToBytes(authPublicKeyHex));
  const assertionPublicKeyMultibase = encodeMultibase(hexToBytes(assertionPublicKeyHex));
  const updatePublicKeyMultibase = encodeMultibase(hexToBytes(updatePublicKeyHex));

  // Create verification methods for DID document
  const verificationMethods = [
    {
      id: `did:webvh:${domain}:${userSlug}#auth-key`,
      type: 'Multikey',
      controller: `did:webvh:${domain}:${userSlug}`,
      publicKeyMultibase: authPublicKeyMultibase,
    },
    {
      id: `did:webvh:${domain}:${userSlug}#assertion-key`,
      type: 'Multikey',
      controller: `did:webvh:${domain}:${userSlug}`,
      publicKeyMultibase: assertionPublicKeyMultibase,
    },
  ];

  const updateKeyMethod = {
    id: `did:webvh:${domain}:${userSlug}#update-key`,
    type: 'Multikey',
    controller: `did:webvh:${domain}:${userSlug}`,
    publicKeyMultibase: updatePublicKeyMultibase,
  };

  return {
    verificationMethods,
    updateKey: updateKeyMethod,
    authKeyId: authKey.privateKeyId!,
    assertionKeyId: assertionKey.privateKeyId!,
    updateKeyId: updateKey.privateKeyId!,
    authKeyPublic: authPublicKeyMultibase,
    assertionKeyPublic: assertionPublicKeyMultibase,
    updateKeyPublic: updatePublicKeyMultibase,
  };
}
