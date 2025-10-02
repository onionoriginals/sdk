import { PrivyClient } from "@privy-io/server-auth";
import { convertToMultibase, extractPublicKeyFromWallet } from "./key-utils";

export interface DIDCreationResult {
  did: string;
  didDocument: any;
  authWalletId: string;
  assertionWalletId: string;
  updateWalletId: string;
  authKeyPublic: string;
  assertionKeyPublic: string;
  updateKeyPublic: string;
  didCreatedAt: Date;
}

/**
 * Generate a sanitized user slug from Privy user ID
 * @param privyUserId - The Privy user ID (e.g., "did:privy:...")
 * @returns Sanitized slug for use in did:webvh
 */
function generateUserSlug(privyUserId: string): string {
  // Strip "did:privy:" prefix if present
  let slug = privyUserId.replace(/^did:privy:/, '');
  
  // Convert to lowercase and replace invalid characters with hyphens
  slug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  
  // Remove consecutive hyphens and trim
  slug = slug.replace(/-+/g, '-').replace(/^-|-$/g, '');
  
  return slug;
}

/**
 * Create a DID:WebVH for a user using Privy-managed wallets
 * @param privyUserId - The Privy user ID
 * @param privyClient - Initialized Privy client
 * @param domain - Domain to use in the DID (e.g., "localhost:5000" or "app.example.com")
 * @returns DID creation result with all metadata
 */
export async function createUserDID(
  privyUserId: string,
  privyClient: PrivyClient,
  domain: string = process.env.DID_DOMAIN || process.env.VITE_APP_DOMAIN || 'localhost:5000'
): Promise<DIDCreationResult> {
  try {
    // Get policy IDs from environment (may be required by Privy)
    const rawPolicyIds = process.env.PRIVY_EMBEDDED_WALLET_POLICY_IDS || "";
    const policyIds = rawPolicyIds
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    console.log(`Creating DID for user ${privyUserId}...`);

    // Step 1: Create Bitcoin wallet (for authentication key)
    console.log('Creating Bitcoin wallet for authentication...');
    const btcWallet = await privyClient.walletApi.createWallet({
      owner: {
        userId: privyUserId,
      },
      chainType: "bitcoin-segwit",
      policyIds: policyIds.length > 0 ? policyIds : [],
    });

    // Step 2: Create first Stellar wallet (for assertion method)
    console.log('Creating Stellar wallet for assertion...');
    const stellarAssertionWallet = await privyClient.walletApi.createWallet({
      owner: {
        userId: privyUserId,
      },
      chainType: "stellar",
      policyIds: policyIds.length > 0 ? policyIds : [],
    });

    // Step 3: Create second Stellar wallet (for DID updates)
    console.log('Creating Stellar wallet for updates...');
    const stellarUpdateWallet = await privyClient.walletApi.createWallet({
      owner: {
        userId: privyUserId,
      },
      chainType: "stellar",
      policyIds: policyIds.length > 0 ? policyIds : [],
    });

    // Step 4: Extract public keys from wallets
    console.log('Extracting public keys...');
    
    // For Bitcoin, we need to extract the public key from the wallet
    // Privy returns the address, but we need the actual public key
    // The wallet object should contain the public key or we derive it from address
    const btcPublicKeyHex = extractPublicKeyFromWallet(btcWallet);
    if (!btcPublicKeyHex) {
      throw new Error('Failed to extract Bitcoin public key from wallet');
    }

    const stellarAssertionKeyHex = extractPublicKeyFromWallet(stellarAssertionWallet);
    if (!stellarAssertionKeyHex) {
      throw new Error('Failed to extract Stellar assertion public key from wallet');
    }

    const stellarUpdateKeyHex = extractPublicKeyFromWallet(stellarUpdateWallet);
    if (!stellarUpdateKeyHex) {
      throw new Error('Failed to extract Stellar update public key from wallet');
    }

    // Step 5: Convert public keys to multibase format
    console.log('Converting keys to multibase format...');
    const authKeyMultibase = convertToMultibase(btcPublicKeyHex, 'Secp256k1');
    const assertionKeyMultibase = convertToMultibase(stellarAssertionKeyHex, 'Ed25519');
    const updateKeyMultibase = convertToMultibase(stellarUpdateKeyHex, 'Ed25519');

    // Step 6: Generate user slug and DID
    const userSlug = generateUserSlug(privyUserId);
    
    // URL-encode the domain to handle ports (e.g., localhost:5000 -> localhost%3A5000)
    // This is required by the DID:WebVH spec for proper transformation
    const encodedDomain = encodeURIComponent(domain);
    const did = `did:webvh:${encodedDomain}:${userSlug}`;

    console.log(`Generated DID: ${did}`);

    // Step 7: Create DID document
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
        },
        {
          "id": `${did}#update-key`,
          "type": "Multikey",
          "controller": did,
          "publicKeyMultibase": updateKeyMultibase
        }
      ],
      "authentication": [`${did}#auth-key`],
      "assertionMethod": [`${did}#assertion-key`]
    };

    console.log('DID document created successfully');

    // Step 8: Return all metadata
    return {
      did,
      didDocument,
      authWalletId: btcWallet.id,
      assertionWalletId: stellarAssertionWallet.id,
      updateWalletId: stellarUpdateWallet.id,
      authKeyPublic: authKeyMultibase,
      assertionKeyPublic: assertionKeyMultibase,
      updateKeyPublic: updateKeyMultibase,
      didCreatedAt: new Date(),
    };
  } catch (error) {
    console.error('Error creating DID:', error);
    throw new Error(`Failed to create DID: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get user slug from a DID
 * @param did - The full DID (e.g., "did:webvh:localhost%3A5000:user-123")
 * @returns The user slug or null if invalid format
 */
export function getUserSlugFromDID(did: string): string | null {
  // DID format: did:webvh:{encoded-domain}:{slug}
  // The domain is URL-encoded, so colons in ports become %3A
  // We split on ':' and take the last segment as the slug
  const parts = did.split(':');
  
  // Valid format: ['did', 'webvh', '{encoded-domain}', '{slug}']
  // Minimum 4 parts, last part is the slug
  if (parts.length < 4 || parts[0] !== 'did' || parts[1] !== 'webvh') {
    return null;
  }
  
  // Return the last segment (the user slug)
  return parts[parts.length - 1];
}
