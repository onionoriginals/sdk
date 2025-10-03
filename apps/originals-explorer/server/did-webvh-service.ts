import { PrivyClient } from "@privy-io/server-auth";
import { convertToMultibase, extractPublicKeyFromWallet } from "./key-utils";
import { resolveDID } from "didwebvh-ts";
import { originalsSdk } from "./originals";
import { 
  createVerificationMethodsFromPrivy, 
  createPrivySigner 
} from "./privy-signer";
import * as path from 'path';

export interface DIDWebVHCreationResult {
  did: string;
  didDocument: any;
  authWalletId: string;
  assertionWalletId: string;
  updateWalletId: string;
  authKeyPublic: string;
  assertionKeyPublic: string;
  updateKeyPublic: string;
  didCreatedAt: Date;
  didSlug: string;
  didLog: any; // The DID log from didwebvh-ts
  logPath?: string; // Path where the DID log was saved
}

/**
 * Generate a sanitized user slug from Privy user ID
 * @param privyUserId - The Privy user ID (e.g., "did:privy:cltest123456" or "cltest123456")
 * @returns Sanitized slug for use in did:webvh
 */
function generateUserSlug(privyUserId: string): string {
  // Strip "did:privy:" prefix if present
  let slug = privyUserId.replace(/^did:privy:/, '');
  
  // Sanitize: lowercase and replace any non-alphanumeric with hyphens
  const sanitized = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  
  // Remove consecutive hyphens and trim
  return sanitized.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Create a DID:WebVH for a user using Privy-managed wallets
 * Uses the Originals SDK with custom Privy signer integration
 * @param privyUserId - The Privy user ID
 * @param privyClient - Initialized Privy client
 * @param domain - Domain to use in the DID (default: from env)
 * @returns DID creation result with all metadata
 */
export async function createUserDIDWebVH(
  privyUserId: string,
  privyClient: PrivyClient,
  domain: string = process.env.DID_DOMAIN || process.env.VITE_APP_DOMAIN || 'localhost:5000'
): Promise<DIDWebVHCreationResult> {
  try {
    console.log(`Creating DID:WebVH for user ${privyUserId} using Originals SDK...`);

    // Generate user slug
    const userSlug = generateUserSlug(privyUserId);

    // Create verification methods and wallets using Privy
    const {
      verificationMethods,
      updateKey,
      authWalletId,
      updateWalletId,
    } = await createVerificationMethodsFromPrivy(
      privyUserId,
      privyClient,
      domain,
      userSlug
    );

    // Create the signer using the update wallet (will be used to sign the DID creation)
    const encodedDomain = encodeURIComponent(domain);
    const did = `did:webvh:${encodedDomain}:${userSlug}`;
    const verificationMethodId = updateKey; // Use the update key as verification method

    const signer = await createPrivySigner(
      privyUserId,
      updateWalletId,
      privyClient,
      verificationMethodId
    );

    // Determine output directory for DID logs
    const publicDir = process.env.PUBLIC_DIR || path.join(process.cwd(), 'public');
    const outputDir = path.join(publicDir, '.well-known');

    // Create the DID using the Originals SDK with Privy signer
    const result = await originalsSdk.webvh.createDIDWebVH({
      domain,
      paths: [userSlug],
      portable: false,
      externalSigner: signer,
      verificationMethods,
      updateKeys: [updateKey],
      outputDir,
    });

    console.log(`Created DID:WebVH with SDK: ${result.did}`);
    console.log(`DID log saved to: ${result.logPath}`);

    return {
      did: result.did,
      didDocument: result.didDocument as any,
      authWalletId,
      assertionWalletId: authWalletId, // Same as auth for now
      updateWalletId,
      authKeyPublic: verificationMethods[0].publicKeyMultibase,
      assertionKeyPublic: verificationMethods[0].publicKeyMultibase,
      updateKeyPublic: updateKey.replace('did:key:', ''),
      didCreatedAt: new Date(),
      didSlug: userSlug,
      didLog: result.log,
      logPath: result.logPath,
    };
  } catch (error) {
    console.error('Error creating DID:WebVH with SDK:', error);
    
    // If the SDK method fails due to missing Privy signing implementation,
    // provide a helpful error message
    if (error instanceof Error && error.message.includes('Privy signing')) {
      console.error(
        '\n' + '='.repeat(80) + '\n' +
        'PRIVY SIGNING NOT YET IMPLEMENTED\n' +
        '='.repeat(80) + '\n' +
        'The DID creation failed because Privy signing is not yet implemented.\n' +
        'To complete this integration:\n' +
        '1. Check Privy documentation for the wallet signing API\n' +
        '2. Update apps/originals-explorer/server/privy-signer.ts\n' +
        '3. Implement the sign() method with the correct Privy API calls\n' +
        '='.repeat(80) + '\n'
      );
    }
    
    throw new Error(`Failed to create DID:WebVH: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolve a DID:WebVH using the didwebvh-ts library
 * @param did - The DID to resolve
 * @returns The resolved DID document or null if not found
 */
export async function resolveDIDWebVH(did: string): Promise<any | null> {
  try {
    const result = await resolveDID(did);
    return result.doc;
  } catch (error) {
    console.error('Error resolving DID:WebVH:', error);
    return null;
  }
}

/**
 * Get user slug from a DID:WebVH
 * @param did - The full DID
 * @returns The user slug or null if invalid format
 */
export function getUserSlugFromDID(did: string): string | null {
  const parts = did.split(':');
  if (parts.length < 4 || parts[0] !== 'did' || parts[1] !== 'webvh') {
    return null;
  }
  return parts[parts.length - 1];
}
