import { storage } from "./storage";

export type KeyPurpose = 'authentication' | 'assertion' | 'update';

/**
 * Sign data using a user's Turnkey-managed key
 * This function keeps all private keys secure within Turnkey's infrastructure
 * 
 * @param userId - The user ID
 * @param keyPurpose - Which key to use ('authentication', 'assertion', or 'update')
 * @param data - The data to sign (as a string or Buffer)
 * @param turnkeyClient - Initialized Turnkey client (from @originals/auth)
 * @returns The signature as a string
 */
export async function signWithUserKey(
  userId: string,
  keyPurpose: KeyPurpose,
  data: string | Buffer,
  turnkeyClient: any
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

    // Get the appropriate Turnkey wallet ID based on key purpose
    let walletId: string | null;
    switch (keyPurpose) {
      case 'authentication':
        walletId = user.authWalletId;
        break;
      case 'assertion':
        walletId = user.assertionWalletId;
        break;
      case 'update':
        walletId = user.updateWalletId;
        break;
      default:
        throw new Error(`Invalid key purpose: ${keyPurpose}`);
    }

    if (!walletId) {
      throw new Error(`No ${keyPurpose} wallet found for user ${userId}`);
    }

    // Convert data to appropriate format
    const dataToSign = typeof data === 'string' ? data : data.toString('hex');

    // Use Turnkey's signing API
    // Note: This requires @originals/auth to be properly configured
    console.log(`Signing data with ${keyPurpose} key (wallet ${walletId})...`);
    
    // TODO: Integrate with @originals/auth TurnkeySigner
    // Example:
    // const signer = await turnkeyClient.createSigner(walletId);
    // const signature = await signer.sign(dataToSign);
    
    throw new Error(
      'Turnkey signing integration pending. ' +
      'Use @originals/auth TurnkeySigner for signing operations. ' +
      `Wallet ID: ${walletId}, Key purpose: ${keyPurpose}`
    );

    // return signature;
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
 * @param userId - The user ID
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
 * @param userId - The user ID
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
