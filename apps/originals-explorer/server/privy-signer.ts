/**
 * Privy Signer - Integration between Privy key management and didwebvh-ts
 * 
 * This module provides a custom signer implementation that works with Privy-managed
 * keys while maintaining compatibility with the didwebvh-ts library.
 */

import { PrivyClient } from "@privy-io/node";
import { ExternalSigner, ExternalVerifier } from "@originals/sdk";
import { multikey } from "@originals/sdk";
import { extractPublicKeyFromWallet, convertToMultibase, bytesToHex } from "./key-utils";
import { sha512 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import * as ed25519 from '@noble/ed25519';

// Configure @noble/ed25519 with required SHA-512 function
// @noble/ed25519 v2.x requires sha512Sync to be set on utils
const sha512Fn = (...msgs: Uint8Array[]) => sha512(concatBytes(...msgs));

// Initialize Ed25519 configuration
// This must be done before using any ed25519 functions
try {
  // Try to configure utils if it exists
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
 * Privy-based signer for DID:WebVH operations
 * Implements the ExternalSigner interface for use with the Originals SDK
 */
export class PrivyWebVHSigner implements ExternalSigner, ExternalVerifier {
  private walletId: string;
  private publicKeyMultibase: string;
  private privyClient: PrivyClient;
  private verificationMethodId: string;
  private userAuthToken: string;

  constructor(
    walletId: string,
    publicKeyMultibase: string,
    privyClient: PrivyClient,
    verificationMethodId: string,
    userAuthToken: string
  ) {
    this.walletId = walletId;
    this.publicKeyMultibase = publicKeyMultibase;
    this.privyClient = privyClient;
    this.verificationMethodId = verificationMethodId;
    this.userAuthToken = userAuthToken;
  }

  /**
   * Sign data using Privy's wallet API
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
      
      // Convert canonical data to hex format for Privy's rawSign API
      const dataHex = `0x${bytesToHex(dataToSign)}`;
      
      // Sign using Privy's wallet API with user authorization context
      const { signature, encoding } = await this.privyClient.wallets().rawSign(this.walletId, {
        authorization_context: {
          user_jwts: [this.userAuthToken],
        },
        params: { hash: dataHex },
      });
      
      // Convert signature based on encoding
      let signatureBytes: Buffer;
      if (encoding === 'hex' || !encoding) {
        // Remove 0x prefix if present
        const cleanSig = signature.startsWith('0x') ? signature.slice(2) : signature;
        signatureBytes = Buffer.from(cleanSig, 'hex');
      } else if (encoding === 'base64') {
        signatureBytes = Buffer.from(signature, 'base64');
      } else {
        throw new Error(`Unsupported signature encoding: ${encoding}`);
      }
      
      // Ed25519 signatures should be exactly 64 bytes
      if (signatureBytes.length === 65) {
        // Remove recovery byte if present (common in some implementations)
        signatureBytes = signatureBytes.slice(0, 64);
      } else if (signatureBytes.length !== 64) {
        throw new Error(`Invalid Ed25519 signature length: ${signatureBytes.length} (expected 64 bytes)`);
      }
      
      // Encode signature as multibase and return
      const proofValue = multikey.encodeMultibase(signatureBytes);
      return { proofValue };
      
    } catch (error) {
      console.error('Error signing with Privy:', error);
      throw new Error(
        `Failed to sign with Privy: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Verify a signature (optional - can delegate to didwebvh-ts)
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
      // Stellar public keys have a version byte prefix, so remove it if present
      let ed25519PublicKey = publicKey;
      if (publicKey.length === 33) {
        ed25519PublicKey = publicKey.slice(1);
      } else if (publicKey.length !== 32) {
        return false;
      }
      
      // Ensure sha512Sync is set (required by @noble/ed25519)
      if (typeof (ed25519 as any).utils?.sha512Sync !== 'function') {
        (ed25519 as any).utils.sha512Sync = sha512Fn;
      }
      
      return await ed25519.verify(signature, message, ed25519PublicKey);
    } catch (error) {
      console.error('Error verifying signature with Privy:', error);
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
 * Create a Privy signer for a user's wallet
 * @param privyUserId - The Privy user ID
 * @param walletId - The wallet ID to use for signing
 * @param privyClient - Initialized Privy client
 * @param verificationMethodId - The DID verification method ID
 * @param userAuthToken - The user's JWT token for authorization
 * @returns A configured PrivyWebVHSigner
 */
export async function createPrivySigner(
  privyUserId: string,
  walletId: string,
  privyClient: PrivyClient,
  verificationMethodId: string,
  userAuthToken: string
): Promise<PrivyWebVHSigner> {
  // Get wallet details from Privy
  const user = await privyClient.users()._get(privyUserId);
  const wallets = user.linked_accounts?.filter((a: any) => a.type === 'wallet') || [];
  const wallet = wallets.find((w: any) => w.id === walletId);
  
  if (!wallet) {
    throw new Error(`Wallet not found: ${walletId}`);
  }

  // Extract and convert public key
  const publicKeyHex = extractPublicKeyFromWallet(wallet);
  const publicKeyMultibase = convertToMultibase(publicKeyHex, 'Ed25519'); // Stellar uses Ed25519

  return new PrivyWebVHSigner(
    walletId,
    publicKeyMultibase,
    privyClient,
    verificationMethodId,
    userAuthToken
  );
}

/**
 * Create verification methods for a user's Privy wallets
 * @param privyUserId - The Privy user ID  
 * @param privyClient - Initialized Privy client
 * @param domain - The domain for the DID
 * @param userSlug - The user slug for the DID
 * @returns Array of verification methods and the update key
 */
export async function createVerificationMethodsFromPrivy(
  privyUserId: string,
  privyClient: PrivyClient,
  domain: string,
  userSlug: string
): Promise<{
  verificationMethods: Array<{
    type: string;
    publicKeyMultibase: string;
  }>;
  updateKey: string;
  authWalletId: string;
  updateWalletId: string;
}> {
  // Get or create wallets for the user
  const user = await privyClient.users()._get(privyUserId);
  let wallets = user.linked_accounts?.filter((a: any) => a.type === 'wallet') || [];
  
  // Get policy IDs from environment
  const rawPolicyIds = process.env.PRIVY_EMBEDDED_WALLET_POLICY_IDS || "";
  const policyIds = rawPolicyIds
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Ensure we have at least 2 Stellar wallets (one for auth, one for updates)
  const stellarWallets = wallets.filter((w: any) => w.chain_type === 'stellar');
  
  let authWallet, updateWallet;
  
  if (stellarWallets.length === 0) {
    // Create both wallets
    authWallet = await privyClient.wallets().create({
      owner: { user_id: privyUserId },
      chain_type: "stellar",
      policy_ids: policyIds.length > 0 ? policyIds : [],
    });
    
    updateWallet = await privyClient.wallets().create({
      owner: { user_id: privyUserId },
      chain_type: "stellar",
      policy_ids: policyIds.length > 0 ? policyIds : [],
    });
  } else if (stellarWallets.length === 1) {
    // Use existing wallet for auth, create one for updates
    authWallet = stellarWallets[0];
    updateWallet = await privyClient.wallets().create({
      owner: { user_id: privyUserId },
      chain_type: "stellar",
      policy_ids: policyIds.length > 0 ? policyIds : [],
    });
  } else {
    // Use existing wallets
    authWallet = stellarWallets[0];
    updateWallet = stellarWallets[1];
  }

  // Extract and convert public keys
  const authPublicKeyHex = extractPublicKeyFromWallet(authWallet);
  const updatePublicKeyHex = extractPublicKeyFromWallet(updateWallet);
  
  const authKeyMultibase = convertToMultibase(authPublicKeyHex, 'Ed25519');
  const updateKeyMultibase = convertToMultibase(updatePublicKeyHex, 'Ed25519');

  // Create DID for verification method IDs
  const encodedDomain = encodeURIComponent(domain);
  const did = `did:webvh:${encodedDomain}:${userSlug}`;

  return {
    verificationMethods: [
      {
        type: 'Multikey',
        publicKeyMultibase: authKeyMultibase,
      }
    ],
    updateKey: `did:key:${updateKeyMultibase}`,
    authWalletId: (authWallet as any).id,
    updateWalletId: (updateWallet as any).id,
  };
}
