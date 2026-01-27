/**
 * Server-side Turnkey client utilities
 * 
 * Uses @turnkey/http for lightweight HTTP-only API access (~23MB)
 * instead of @turnkey/sdk-server which pulls in heavy EVM dependencies (~125MB+)
 */

import { TurnkeyClient } from '@turnkey/http';
import { ApiKeyStamper } from '@turnkey/api-key-stamper';

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
 * Wrapper class that provides the same simplified interface as @turnkey/sdk-server
 * but uses the lightweight @turnkey/http package (~23MB vs ~125MB+)
 */
export class TurnkeyHttpClient {
  private client: TurnkeyClient;
  public readonly organizationId: string;

  constructor(client: TurnkeyClient, organizationId: string) {
    this.client = client;
    this.organizationId = organizationId;
  }

  /**
   * Get the underlying HTTP client for direct API access
   */
  apiClient() {
    const self = this;
    return {
      /** Get sub-organization IDs */
      async getSubOrgIds(params: {
        organizationId: string;
        filterType: string;
        filterValue: string;
      }) {
        const result = await self.client.getSubOrgIds({
          organizationId: params.organizationId,
          filterType: params.filterType,
          filterValue: params.filterValue,
        });
        return result;
      },

      /** Get wallets for an organization */
      async getWallets(params: { organizationId: string }) {
        const result = await self.client.getWallets({
          organizationId: params.organizationId,
        });
        return result;
      },

      /** Create a sub-organization with wallet */
      async createSubOrganization(params: {
        subOrganizationName: string;
        rootUsers: Array<{
          userName: string;
          userEmail: string;
          apiKeys: unknown[];
          authenticators: unknown[];
          oauthProviders: unknown[];
        }>;
        rootQuorumThreshold: number;
        wallet: {
          walletName: string;
          accounts: Array<{
            curve: string;
            pathFormat: string;
            path: string;
            addressFormat: string;
          }>;
        };
      }) {
        const result = await self.client.createSubOrganization({
          type: 'ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7',
          timestampMs: Date.now().toString(),
          organizationId: self.organizationId,
          parameters: {
            subOrganizationName: params.subOrganizationName,
            rootUsers: params.rootUsers.map(user => ({
              userName: user.userName,
              userEmail: user.userEmail,
              apiKeys: user.apiKeys as [],
              authenticators: user.authenticators as [],
              oauthProviders: user.oauthProviders as [],
            })),
            rootQuorumThreshold: params.rootQuorumThreshold,
            wallet: {
              walletName: params.wallet.walletName,
              accounts: params.wallet.accounts.map(acc => ({
                curve: acc.curve as 'CURVE_SECP256K1' | 'CURVE_ED25519',
                pathFormat: acc.pathFormat as 'PATH_FORMAT_BIP32',
                path: acc.path,
                addressFormat: acc.addressFormat as 'ADDRESS_FORMAT_ETHEREUM' | 'ADDRESS_FORMAT_SOLANA',
              })),
            },
          },
        });
        return result;
      },

      /** Initialize OTP */
      async initOtp(params: {
        otpType: string;
        contact: string;
        userIdentifier: string;
        appName: string;
        otpLength: number;
        alphanumeric: boolean;
      }) {
        const result = await self.client.initOtp({
          type: 'ACTIVITY_TYPE_INIT_OTP_V2',
          timestampMs: Date.now().toString(),
          organizationId: self.organizationId,
          parameters: {
            otpType: params.otpType as 'OTP_TYPE_EMAIL' | 'OTP_TYPE_SMS',
            contact: params.contact,
            userIdentifier: params.userIdentifier,
            appName: params.appName,
            otpLength: params.otpLength,
            alphanumeric: params.alphanumeric,
          },
        });
        // Extract otpId from the activity result
        const activity = result.activity;
        const initResult = (activity?.result as { initOtpResult?: { otpId?: string } })?.initOtpResult;
        return { otpId: initResult?.otpId };
      },

      /** Verify OTP */
      async verifyOtp(params: {
        otpId: string;
        otpCode: string;
        expirationSeconds: string;
      }) {
        const result = await self.client.verifyOtp({
          type: 'ACTIVITY_TYPE_VERIFY_OTP',
          timestampMs: Date.now().toString(),
          organizationId: self.organizationId,
          parameters: {
            otpId: params.otpId,
            otpCode: params.otpCode,
            expirationSeconds: params.expirationSeconds,
          },
        });
        // Extract verification token from activity result
        const activity = result.activity;
        const verifyResult = (activity?.result as { verifyOtpResult?: { verificationToken?: string } })?.verifyOtpResult;
        return { verificationToken: verifyResult?.verificationToken };
      },

      /** Sign raw payload */
      async signRawPayload(params: {
        organizationId: string;
        signWith: string;
        payload: string;
        encoding: string;
        hashFunction: string;
      }) {
        const result = await self.client.signRawPayload({
          type: 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2',
          timestampMs: Date.now().toString(),
          organizationId: params.organizationId,
          parameters: {
            signWith: params.signWith,
            payload: params.payload,
            encoding: params.encoding as 'PAYLOAD_ENCODING_HEXADECIMAL',
            hashFunction: params.hashFunction as 'HASH_FUNCTION_NO_OP',
          },
        });
        return result;
      },
    };
  }
}

/**
 * Create a Turnkey server client using the lightweight HTTP package
 */
export function createTurnkeyClient(config?: Partial<TurnkeyClientConfig>): TurnkeyHttpClient {
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

  // Create API key stamper for request signing
  const stamper = new ApiKeyStamper({
    apiPublicKey,
    apiPrivateKey,
  });

  // Create HTTP client
  const client = new TurnkeyClient(
    { baseUrl: config?.apiBaseUrl ?? 'https://api.turnkey.com' },
    stamper
  );

  return new TurnkeyHttpClient(client, organizationId);
}

/**
 * Get or create a Turnkey sub-organization for a user
 * Creates sub-org with email-only root user and required wallet accounts
 */
export async function getOrCreateTurnkeySubOrg(
  email: string,
  turnkeyClient: TurnkeyHttpClient
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







