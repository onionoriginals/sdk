import { Turnkey } from "@turnkey/sdk-server";
import { resolveDID } from "didwebvh-ts";
import { originalsSdk } from "./originals";
import {
  createVerificationMethodsFromTurnkey,
  createTurnkeySigner
} from "./turnkey-signer";

export interface DIDWebVHCreationResult {
  did: string;
  didDocument: any;
  authKeyId: string;
  assertionKeyId: string;
  updateKeyId: string;
  authKeyPublic: string;
  assertionKeyPublic: string;
  updateKeyPublic: string;
  didCreatedAt: Date;
  didSlug: string;
  didLog: any; // The DID log from didwebvh-ts
  logPath?: string; // Path where the DID log was saved
}

/**
 * Generate a sanitized user slug from Turnkey user ID
 * @param turnkeyUserId - The Turnkey user/sub-org ID
 * @returns Sanitized slug for use in did:webvh
 */
function generateUserSlug(turnkeyUserId: string): string {
  // Sanitize: lowercase and replace any non-alphanumeric with hyphens
  const sanitized = turnkeyUserId.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // Remove consecutive hyphens and trim
  return sanitized.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Create a DID:WebVH for a user using Turnkey-managed keys
 * Uses the Originals SDK with custom Turnkey signer integration
 * @param organizationId - The Turnkey sub-organization ID for the user
 * @param turnkeyClient - Initialized Turnkey client
 * @param domain - Domain to use in the DID (default: from env)
 * @returns DID creation result with all metadata
 */
export async function createUserDIDWebVH(
  organizationId: string,
  turnkeyClient: Turnkey,
  domain: string = process.env.DID_DOMAIN || process.env.VITE_APP_DOMAIN || 'localhost:5000'
): Promise<DIDWebVHCreationResult> {
  try {
    // Generate user slug from organization ID
    const userSlug = generateUserSlug(organizationId);

    // Create verification methods and keys using Turnkey
    const {
      verificationMethods,
      updateKey,
      authKeyId,
      updateKeyId,
    } = await createVerificationMethodsFromTurnkey(
      organizationId,
      turnkeyClient,
      domain,
      userSlug
    );

    // Create the signer using the update key (will be used to sign the DID creation)
    const encodedDomain = encodeURIComponent(domain);
    const did = `did:webvh:${encodedDomain}:${userSlug}`;
    const verificationMethodId = updateKey; // Use the update key as verification method

    const signer = await createTurnkeySigner(
      organizationId,
      updateKeyId,
      turnkeyClient,
      verificationMethodId
    );

    // Create the DID using the Originals SDK DIDManager with Turnkey signer
    // No outputDir - we don't need files on disk, everything is served from the database
    const result = await originalsSdk.did.createDIDWebVH({
      domain,
      paths: [userSlug],
      portable: false,
      externalSigner: signer,
      verificationMethods,
      updateKeys: [updateKey],
      // outputDir: undefined - don't write files to disk, serve from database instead
    });

    return {
      did: result.did,
      didDocument: result.didDocument as any,
      authKeyId,
      assertionKeyId: authKeyId, // Same as auth for now
      updateKeyId,
      authKeyPublic: verificationMethods[0].publicKeyMultibase,
      assertionKeyPublic: verificationMethods[0].publicKeyMultibase,
      updateKeyPublic: updateKey.replace('did:key:', ''),
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
