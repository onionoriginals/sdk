import { PrivyClient } from "@privy-io/server-auth";
import { convertToMultibase, extractPublicKeyFromWallet } from "./key-utils";
import { resolveDID } from "didwebvh-ts";

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
 * Note: Creates spec-compliant DID documents manually since didwebvh-ts requires
 * signing capabilities that aren't available with Privy-managed wallets
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
    console.log(`Creating DID:WebVH for user ${privyUserId}...`);

    // Get policy IDs from environment
    const rawPolicyIds = process.env.PRIVY_EMBEDDED_WALLET_POLICY_IDS || "";
    const policyIds = rawPolicyIds
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Step 1: Create Bitcoin wallet (for authentication key)
    const btcWallet = await privyClient.walletApi.createWallet({
      owner: { userId: privyUserId },
      chainType: "bitcoin-segwit",
      policyIds: policyIds.length > 0 ? policyIds : [],
    });

    // Step 2: Create first Stellar wallet (for assertion method)
    const stellarAssertionWallet = await privyClient.walletApi.createWallet({
      owner: { userId: privyUserId },
      chainType: "stellar",
      policyIds: policyIds.length > 0 ? policyIds : [],
    });

    // Step 3: Create second Stellar wallet (for DID updates)
    const stellarUpdateWallet = await privyClient.walletApi.createWallet({
      owner: { userId: privyUserId },
      chainType: "stellar",
      policyIds: policyIds.length > 0 ? policyIds : [],
    });

    // Step 4: Extract public keys from wallets
    const btcPublicKeyHex = extractPublicKeyFromWallet(btcWallet);
    const stellarAssertionKeyHex = extractPublicKeyFromWallet(stellarAssertionWallet);
    const stellarUpdateKeyHex = extractPublicKeyFromWallet(stellarUpdateWallet);

    // Step 5: Convert public keys to multibase format
    const authKeyMultibase = convertToMultibase(btcPublicKeyHex, 'Secp256k1');
    const assertionKeyMultibase = convertToMultibase(stellarAssertionKeyHex, 'Ed25519');
    const updateKeyMultibase = convertToMultibase(stellarUpdateKeyHex, 'Ed25519');

    // Step 6: Generate user slug
    const userSlug = generateUserSlug(privyUserId);

    // Step 7: Create DID:WebVH document manually (spec-compliant)
    // Note: We create the document manually since didwebvh-ts requires signing capabilities
    // that we don't have with Privy-managed wallets (no access to private keys)
    console.log('Creating DID:WebVH document...');
    
    const encodedDomain = encodeURIComponent(domain);
    const did = `did:webvh:${encodedDomain}:${userSlug}`;
    
    // Create DID document according to DID:WebVH spec
    const didDocument = {
      "@context": [
        "https://www.w3.org/ns/did/v1",
        "https://w3id.org/security/multikey/v1"
      ],
      "id": did,
      "verificationMethod": [
        {
          "id": `${did}#auth-key`,
          "type": "Multikey",
          "controller": did,
          "publicKeyMultibase": authKeyMultibase
        },
        {
          "id": `${did}#assertion-key`,
          "type": "Multikey",
          "controller": did,
          "publicKeyMultibase": assertionKeyMultibase
        }
      ],
      "authentication": [`${did}#auth-key`],
      "assertionMethod": [`${did}#assertion-key`]
    };

    // Create a basic DID log entry (for future didwebvh-ts integration)
    const didLog = [{
      operation: "create",
      did,
      timestamp: new Date().toISOString(),
      // Note: In a full implementation, this would include cryptographic proofs
      // For now, we store the metadata for future signing integration
      metadata: {
        authWalletId: btcWallet.id,
        assertionWalletId: stellarAssertionWallet.id,
        updateWalletId: stellarUpdateWallet.id,
      }
    }];

    const didResult = {
      did,
      doc: didDocument,
      log: didLog
    };
    
    console.log(`Generated DID:WebVH: ${didResult.did}`);

    return {
      did: didResult.did,
      didDocument: didResult.doc,
      authWalletId: btcWallet.id,
      assertionWalletId: stellarAssertionWallet.id,
      updateWalletId: stellarUpdateWallet.id,
      authKeyPublic: authKeyMultibase,
      assertionKeyPublic: assertionKeyMultibase,
      updateKeyPublic: updateKeyMultibase,
      didCreatedAt: new Date(),
      didSlug: userSlug,
      didLog: didResult.log,
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
