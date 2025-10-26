import { PrivyClient } from "@privy-io/node";
import { convertToMultibase, extractPublicKeyFromWallet } from "./key-utils";
import { originalsSdk } from "./originals";
import { 
  createVerificationMethodsFromPrivy, 
  createPrivySigner 
} from "./privy-signer";

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
 * Create a DID:WebVH for a user using Turnkey-managed keys
 * Uses the Originals SDK with Turnkey signer integration
 * @param turnkeySubOrgId - The Turnkey sub-organization ID
 * @param turnkeyClient - Initialized Turnkey client
 * @param domain - Domain to use in the DID (default: from env)
 * @returns DID creation result with all metadata
 */
export async function createUserDIDWebVH(
  turnkeySubOrgId: string,
  turnkeyClient: any, // Turnkey client type
  domain: string = process.env.DID_DOMAIN || process.env.VITE_APP_DOMAIN || 'localhost:5000'
): Promise<DIDWebVHCreationResult> {
  try {
    // Generate user slug from Turnkey sub-org ID
    const userSlug = generateUserSlug(turnkeySubOrgId);

    // For now, create a simple DID using SDK's built-in key generation
    // TODO: Integrate with Turnkey's key management for production
    const result = await originalsSdk.did.createDIDWebVH({
      domain,
      paths: [userSlug],
      portable: false,
      // Let SDK generate keys internally for now
    });

    // Extract verification methods from the created DID document
    const didDoc = result.didDocument as any;
    const verificationMethod = didDoc.verificationMethod?.[0];
    const publicKeyMultibase = verificationMethod?.publicKeyMultibase || '';

    return {
      did: result.did,
      didDocument: result.didDocument as any,
      authWalletId: turnkeySubOrgId, // Use Turnkey sub-org ID as wallet identifier
      assertionWalletId: turnkeySubOrgId,
      updateWalletId: turnkeySubOrgId,
      authKeyPublic: publicKeyMultibase,
      assertionKeyPublic: publicKeyMultibase,
      updateKeyPublic: publicKeyMultibase,
      didCreatedAt: new Date(),
      didSlug: userSlug,
      didLog: result.log,
      logPath: result.logPath,
    };
  } catch (error) {
    console.error('Error creating DID:WebVH:', error);
    throw new Error(`Failed to create DID:WebVH: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolve a DID:WebVH using the Originals SDK
 * @param did - The DID to resolve
 * @returns The resolved DID document or null if not found
 */
export async function resolveDIDWebVH(did: string): Promise<any | null> {
  try {
    const result = await originalsSdk.did.resolveDID(did);
    return result;
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

/**
 * Publish a DID document to make it publicly accessible
 * @param params - Publishing parameters
 */
export async function publishDIDDocument(params: {
  did: string;
  didDocument: any;
  didLog?: any;
}): Promise<void> {
  const { did, didDocument, didLog } = params;
  
  // Validate DID format
  if (!did.startsWith('did:webvh:')) {
    throw new Error('Invalid DID format: must be a did:webvh identifier');
  }
  
  // Extract slug from did:webvh:domain.com:slug
  const parts = did.split(':');
  if (parts.length < 4) {
    throw new Error('Invalid DID format: missing slug component');
  }
  const slug = parts[parts.length - 1];
  
  if (!slug) {
    throw new Error('Invalid DID format: could not extract slug');
  }
  
  // Import storage dynamically to avoid circular dependency
  const { storage } = await import('./storage');
  
  // Store in database for public access
  await storage.storeDIDDocument(slug, {
    didDocument,
    didLog: didLog || { entries: [] },
    publishedAt: new Date().toISOString()
  });
  
  console.log(`DID document published: ${did}`);
}

/**
 * Resolve a DID document from storage
 * @param did - The DID to resolve
 * @returns The DID document or null if not found
 */
export async function resolveDIDDocument(did: string): Promise<any> {
  // Validate DID format
  if (!did.startsWith('did:webvh:')) {
    throw new Error('Invalid DID format: must be a did:webvh identifier');
  }
  
  const parts = did.split(':');
  if (parts.length < 4) {
    throw new Error('Invalid DID format: missing slug component');
  }
  const slug = parts[parts.length - 1];
  
  if (!slug) {
    throw new Error('Invalid DID format: could not extract slug');
  }
  
  // Import storage dynamically to avoid circular dependency
  const { storage } = await import('./storage');
  
  const doc = await storage.getDIDDocument(slug);
  
  if (!doc) {
    throw new Error('DID document not found');
  }
  
  return doc.didDocument;
}
