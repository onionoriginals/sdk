import { Turnkey } from "@turnkey/sdk-server";
import { storage } from "./storage";

export type KeyPurpose = 'authentication' | 'assertion' | 'update';

/**
 * Sign data using a user's Turnkey-managed key
 * This function keeps all private keys secure within Turnkey's infrastructure
 *
 * @param userId - The Turnkey user/sub-org ID
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

    if (!user.turnkeyUserId) {
      throw new Error(`User ${userId} does not have a Turnkey account`);
    }

    // Get the appropriate Turnkey key ID based on key purpose
    let keyId: string | null;
    switch (keyPurpose) {
      case 'authentication':
        keyId = user.authKeyId;
        break;
      case 'assertion':
        keyId = user.assertionKeyId;
        break;
      case 'update':
        keyId = user.updateKeyId;
        break;
      default:
        throw new Error(`Invalid key purpose: ${keyPurpose}`);
    }

    if (!keyId) {
      throw new Error(`No ${keyPurpose} key found for user ${userId}`);
    }

    // Convert data to hex format for Turnkey
    const dataHex = typeof data === 'string'
      ? Buffer.from(data).toString('hex')
      : data.toString('hex');

    console.log(`Signing data with ${keyPurpose} key (${keyId})...`);

    // Use Turnkey's signRawPayload API to sign the data
    const signResponse = await turnkeyClient.apiClient().signRawPayload({
      signWith: keyId,
      payload: dataHex,
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NO_OP', // Data is already hashed if needed
    });

    // Extract and combine signature components
    const r = signResponse.r;
    const s = signResponse.s;

    if (!r || !s) {
      throw new Error('Invalid signature response from Turnkey');
    }

    const signature = r + s;
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
 * @param userId - The Turnkey user/sub-org ID
 * @param keyPurpose - Which key was used ('authentication', 'assertion', or 'update')
 * @param data - The original data that was signed
 * @param signature - The signature to verify
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
    let publicKey: string | null;
    switch (keyPurpose) {
      case 'authentication':
        publicKey = user.authKeyPublic;
        break;
      case 'assertion':
        publicKey = user.assertionKeyPublic;
        break;
      case 'update':
        publicKey = user.updateKeyPublic;
        break;
      default:
        return false;
    }

    if (!publicKey) {
      return false;
    }

    // TODO: Implement signature verification using the public key
    // This would use the multikey utilities from the SDK to decode the public key
    // and verify the signature
    console.log(`Verifying signature with ${keyPurpose} public key...`);
    
    throw new Error('Signature verification not yet implemented');
    
    // return isValid;
  } catch (error) {
    // Re-throw "not implemented" errors so tests can catch them
    if (error instanceof Error && error.message.includes('not yet implemented')) {
      throw error;
    }
    console.error('Error verifying signature:', error);
    return false;
  }
}

/**
 * Get the verification method ID for a user's key
 *
 * @param userId - The Turnkey user/sub-org ID
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
