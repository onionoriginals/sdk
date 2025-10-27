import { Turnkey } from "@turnkey/sdk-server";
import { convertToMultibase } from "./key-utils";
import { originalsSdk } from "./originals";
import { createTurnkeySigner } from "./turnkey-signer";

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
 * Generate a sanitized user slug from Turnkey sub-org ID
 * @param turnkeySubOrgId - The Turnkey sub-organization ID
 * @returns Sanitized slug for use in did:webvh
 */
function generateUserSlug(turnkeySubOrgId: string): string {
  // Sanitize: lowercase and replace any non-alphanumeric with hyphens
  const sanitized = turnkeySubOrgId.toLowerCase().replace(/[^a-z0-9-]/g, '-');

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
  turnkeyClient: Turnkey,
  domain: string = process.env.DID_DOMAIN || process.env.VITE_APP_DOMAIN || 'localhost:5000'
): Promise<DIDWebVHCreationResult> {
  try {
    // Generate user slug from Turnkey sub-org ID
    const userSlug = generateUserSlug(turnkeySubOrgId);

    // Wallet accounts are created during sub-org creation (see email-auth.ts)
    // They are stored IN the sub-org for proper isolation

    // List wallets in the sub-org
    const walletsResult = await turnkeyClient.apiClient().getWallets({
      organizationId: turnkeySubOrgId,
    });

    const wallets = walletsResult.wallets || [];
    if (wallets.length === 0) {
      throw new Error(
        `No wallets found in sub-org ${turnkeySubOrgId}. ` +
        `This sub-org may have been created before wallet creation was implemented. ` +
        `Please delete it and log in again with a fresh email.`
      );
    }

    // Get the default wallet (first one)
    const wallet = wallets[0];
    console.log(`Using wallet: ${wallet.walletName} (${wallet.walletId})`);

    // Get wallet accounts
    const accountsResult = await turnkeyClient.apiClient().getWalletAccounts({
      organizationId: turnkeySubOrgId,
      walletId: wallet.walletId!,
    });

    const accounts = accountsResult.accounts || [];
    if (accounts.length < 3) {
      throw new Error(
        `Expected 3 wallet accounts but found ${accounts.length} in wallet ${wallet.walletId}`
      );
    }

    // Accounts are created in order: Secp256k1, Ed25519, Ed25519
    const authAccount = accounts[0]; // CURVE_SECP256K1
    const assertionAccount = accounts[1]; // CURVE_ED25519
    const updateAccount = accounts[2]; // CURVE_ED25519

    // Convert Turnkey public keys to multibase format
    const authKeyMultibase = convertToMultibase(authAccount.publicKey || '', 'Secp256k1');
    const assertionKeyMultibase = convertToMultibase(assertionAccount.publicKey || '', 'Ed25519');
    const updateKeyMultibase = convertToMultibase(updateAccount.publicKey || '', 'Ed25519');

    // Create the update signer for DID creation (SDK uses this to sign the initial DID document)
    const encodedDomain = encodeURIComponent(domain);
    const did = `did:webvh:${encodedDomain}:${userSlug}`;
    const updateVerificationMethodId = `${did}#update-key`;

    const updateSigner = await createTurnkeySigner(
      turnkeySubOrgId,
      updateAccount.address!, // Use account address as the signing key identifier
      turnkeyClient,
      updateVerificationMethodId,
      updateKeyMultibase
    );

    // Use the Originals SDK to create the DID:WebVH with Turnkey-managed keys
    const result = await originalsSdk.did.createDIDWebVH({
      domain,
      paths: [userSlug],
      portable: false,
      externalSigner: updateSigner,
      verificationMethods: [
        {
          type: 'Multikey',
          publicKeyMultibase: authKeyMultibase,
        },
        {
          type: 'Multikey',
          publicKeyMultibase: assertionKeyMultibase,
        }
      ],
      updateKeys: [updateVerificationMethodId], // Required when using externalSigner
    });

    return {
      did: result.did,
      didDocument: result.didDocument as any,
      authKeyId: authAccount.address!,
      assertionKeyId: assertionAccount.address!,
      updateKeyId: updateAccount.address!,
      authKeyPublic: authKeyMultibase,
      assertionKeyPublic: assertionKeyMultibase,
      updateKeyPublic: updateKeyMultibase,
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
