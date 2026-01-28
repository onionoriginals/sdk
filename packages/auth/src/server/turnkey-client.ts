/**
 * Server-side Turnkey client utilities
 */

import { Turnkey } from '@turnkey/sdk-server';

export interface TurnkeyClientConfig {
  /** Turnkey API base URL (default: https://api.turnkey.com) */
  apiBaseUrl?: string;
  /** Turnkey API public key */
  apiPublicKey: string;
  /** Turnkey API private key */
  apiPrivateKey: string;
  /** Default organization ID */
  organizationId: string;
}

/**
 * Create a Turnkey server client
 */
export function createTurnkeyClient(config?: Partial<TurnkeyClientConfig>): Turnkey {
  const apiPublicKey = config?.apiPublicKey ?? process.env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = config?.apiPrivateKey ?? process.env.TURNKEY_API_PRIVATE_KEY;
  const organizationId = config?.organizationId ?? process.env.TURNKEY_ORGANIZATION_ID;

  if (!apiPublicKey) {
    throw new Error('TURNKEY_API_PUBLIC_KEY is required');
  }
  if (!apiPrivateKey) {
    throw new Error('TURNKEY_API_PRIVATE_KEY is required');
  }
  if (!organizationId) {
    throw new Error('TURNKEY_ORGANIZATION_ID is required');
  }

  return new Turnkey({
    apiBaseUrl: config?.apiBaseUrl ?? 'https://api.turnkey.com',
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: organizationId,
  });
}

/**
 * Get or create a Turnkey sub-organization for a user
 * Creates sub-org with email-only root user and required wallet accounts
 */
export async function getOrCreateTurnkeySubOrg(
  email: string,
  turnkeyClient: Turnkey
): Promise<string> {
  const organizationId = process.env.TURNKEY_ORGANIZATION_ID;
  if (!organizationId) {
    throw new Error('TURNKEY_ORGANIZATION_ID is required');
  }

  // Generate a consistent base name for lookup
  const baseSubOrgName = `user-${email.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;

  console.log(`🔍 Checking for existing sub-organization for ${email}...`);

  try {
    // Try to get existing sub-organizations by email filter
    const subOrgs = await turnkeyClient.apiClient().getSubOrgIds({
      organizationId,
      filterType: 'EMAIL',
      filterValue: email,
    });

    const subOrgIds = subOrgs.organizationIds || [];
    const existingSubOrgId = subOrgIds.length > 0 ? subOrgIds[0] : null;

    if (existingSubOrgId) {
      console.log(`✅ Found existing sub-organization: ${existingSubOrgId}`);

      // Check if this sub-org has a wallet
      try {
        const walletsCheck = await turnkeyClient.apiClient().getWallets({
          organizationId: existingSubOrgId,
        });
        const walletCount = walletsCheck.wallets?.length || 0;

        if (walletCount > 0) {
          return existingSubOrgId;
        }

        console.log(`⚠️ Sub-org has no wallet, creating new sub-org with wallet...`);
      } catch (walletCheckErr) {
        console.error('Could not check wallet in sub-org:', walletCheckErr);
        return existingSubOrgId;
      }
    }
  } catch {
    console.log(`📝 No existing sub-org found, will create new one`);
  }

  // Generate a unique name for the new sub-org
  const subOrgName = `${baseSubOrgName}-${Date.now()}`;

  console.log(`📧 Creating new Turnkey sub-organization for ${email}...`);

  // Create sub-organization with wallet containing required keys
  const result = await turnkeyClient.apiClient().createSubOrganization({
    subOrganizationName: subOrgName,
    rootUsers: [
      {
        userName: email,
        userEmail: email,
        apiKeys: [],
        authenticators: [],
        oauthProviders: [],
      },
    ],
    rootQuorumThreshold: 1,
    wallet: {
      walletName: 'default-wallet',
      accounts: [
        {
          curve: 'CURVE_SECP256K1',
          pathFormat: 'PATH_FORMAT_BIP32',
          path: "m/44'/0'/0'/0/0", // Bitcoin path for auth-key
          addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
        },
        {
          curve: 'CURVE_ED25519',
          pathFormat: 'PATH_FORMAT_BIP32',
          path: "m/44'/501'/0'/0'", // Ed25519 for assertion-key
          addressFormat: 'ADDRESS_FORMAT_SOLANA',
        },
        {
          curve: 'CURVE_ED25519',
          pathFormat: 'PATH_FORMAT_BIP32',
          path: "m/44'/501'/1'/0'", // Ed25519 for update-key
          addressFormat: 'ADDRESS_FORMAT_SOLANA',
        },
      ],
    },
  });

  const subOrgId = result.activity?.result?.createSubOrganizationResultV7?.subOrganizationId;

  if (!subOrgId) {
    throw new Error('No sub-organization ID returned from Turnkey');
  }

  console.log(`✅ Created sub-organization: ${subOrgId}`);

  return subOrgId;
}







