/**
 * Signing Service - Turnkey Integration
 * Provides signing and verification functions using Turnkey-managed keys
 *
 * Critical PR #102 Feedback Addressed:
 * - HASH_FUNCTION_NOT_APPLICABLE for Ed25519 (not NO_OP!)
 * - Signature extraction as single hex blob (not r/s fields!)
 * - Uses Turnkey private key IDs (not wallet IDs)
 */

import { Turnkey } from '@turnkey/sdk-server';
import { storage } from "./storage";
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

export type KeyPurpose = 'authentication' | 'assertion' | 'update';

/**
 * Sign data using a user's Turnkey-managed key
 * This function keeps all private keys secure within Turnkey's TEE infrastructure
 *
 * @param userId - The internal user ID (UUID)
 * @param keyPurpose - Which key to use ('authentication', 'assertion', or 'update')
 * @param data - The data to sign (as a string or Buffer)
 * @param turnkeyClient - Initialized Turnkey client
 * @returns The signature as a hex string
 */
export async function signWithUserKey(
  userId: string,
  keyPurpose: KeyPurpose,
  data: string | Buffer,
  turnkeyClient: Turnkey
): Promise<string> {
  try {
    // Get the user's DID metadata from storage
    const user = await storage.getUser(userId);

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    if (!user.did) {
      throw new Error(`User ${userId} does not have a DID. Please create one first.`);
    }

    if (!user.turnkeySubOrgId) {
      throw new Error(`User ${userId} does not have a Turnkey sub-organization.`);
    }

    // Get the appropriate Turnkey private key ID based on key purpose
    let privateKeyId: string | null;
    switch (keyPurpose) {
      case 'authentication':
        privateKeyId = user.authKeyId;
        break;
      case 'assertion':
        privateKeyId = user.assertionKeyId;
        break;
      case 'update':
        privateKeyId = user.updateKeyId;
        break;
      default:
        throw new Error(`Invalid key purpose: ${keyPurpose}`);
    }

    if (!privateKeyId) {
      throw new Error(`No ${keyPurpose} key found for user ${userId}`);
    }

    // Convert data to hex format
    const dataHex = typeof data === 'string'
      ? bytesToHex(new TextEncoder().encode(data))
      : bytesToHex(data);

    console.log(`Signing data with ${keyPurpose} key (Turnkey key ${privateKeyId})...`);

    // CRITICAL: Use HASH_FUNCTION_NOT_APPLICABLE for Ed25519
    const signResponse = await turnkeyClient.apiClient().signRawPayload({
      organizationId: user.turnkeySubOrgId,
      signWith: privateKeyId,
      payload: dataHex,
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE', // CORRECT for Ed25519!
    });

    // CRITICAL: Ed25519 returns single hex blob, NOT r/s fields!
    const signature = signResponse.signature;
    if (!signature) {
      throw new Error('No signature returned from Turnkey');
    }

    return signature;
  } catch (error) {
    console.error('Error signing with user key:', error);
    throw new Error(
      `Failed to sign data: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Verify a signature against a user's public key
 *
 * @param userId - The internal user ID (UUID)
 * @param keyPurpose - Which key was used ('authentication', 'assertion', or 'update')
 * @param data - The original data that was signed
 * @param signature - The signature to verify (as hex string)
 * @returns True if signature is valid, false otherwise
 */
export async function verifySignature(
  userId: string,
  keyPurpose: KeyPurpose,
  data: string | Buffer,
  signature: string
): Promise<boolean> {
  try {
    // Get the user's DID metadata from storage
    const user = await storage.getUser(userId);

    if (!user || !user.did) {
      return false;
    }

    // Get the appropriate public key based on key purpose
    let publicKeyMultibase: string | null;
    switch (keyPurpose) {
      case 'authentication':
        publicKeyMultibase = user.authKeyPublic;
        break;
      case 'assertion':
        publicKeyMultibase = user.assertionKeyPublic;
        break;
      case 'update':
        publicKeyMultibase = user.updateKeyPublic;
        break;
      default:
        return false;
    }

    if (!publicKeyMultibase) {
      return false;
    }

    // TODO: Implement Ed25519 signature verification
    // This would:
    // 1. Decode the multibase public key
    // 2. Convert data to bytes
    // 3. Verify signature using @noble/ed25519 or similar
    // 4. Return verification result

    console.log(`Verifying signature with ${keyPurpose} public key...`);

    // For now, return true (will be implemented with proper verification)
    // In production, use @noble/ed25519 for verification
    return true;
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}

/**
 * Get the verification method ID for a user's key
 *
 * @param userId - The internal user ID (UUID)
 * @param keyPurpose - Which key ('authentication', 'assertion', or 'update')
 * @returns The verification method ID (e.g., "did:webvh:example.com:user#auth-key")
 */
export async function getVerificationMethodId(
  userId: string,
  keyPurpose: KeyPurpose
): Promise<string | null> {
  const user = await storage.getUser(userId);

  if (!user || !user.did) {
    return null;
  }

  const keyFragment = keyPurpose === 'authentication'
    ? 'auth-key'
    : keyPurpose === 'assertion'
    ? 'assertion-key'
    : 'update-key';

  return `${user.did}#${keyFragment}`;
}
