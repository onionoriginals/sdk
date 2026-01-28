/**
 * Client-side Turnkey utilities
 * Uses @turnkey/sdk-server for all Turnkey operations (no viem/ethers dependency)
 */

import { Turnkey } from '@turnkey/sdk-server';
import type { TurnkeyWallet, TurnkeyWalletAccount } from '../types';

/**
 * Session expired error for handling token expiration
 */
export class TurnkeySessionExpiredError extends Error {
  constructor(message: string = 'Your Turnkey session has expired. Please log in again.') {
    super(message);
    this.name = 'TurnkeySessionExpiredError';
  }
}

/**
 * Wrapper to handle token expiration errors
 */
export async function withTokenExpiration<T>(
  fn: () => Promise<T>,
  onExpired?: () => void
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const errorStr = JSON.stringify(error);
    if (
      errorStr.toLowerCase().includes('api_key_expired') ||
      errorStr.toLowerCase().includes('expired api key') ||
      errorStr.toLowerCase().includes('"code":16')
    ) {
      console.warn('Detected expired API key, calling onExpired');
      if (onExpired) {
        onExpired();
      }
      throw new TurnkeySessionExpiredError();
    }
    throw error;
  }
}

/**
 * Initialize Turnkey server client
 * Reads from environment variables or provided config
 */
export function initializeTurnkeyClient(config?: {
  apiBaseUrl?: string;
  apiPublicKey?: string;
  apiPrivateKey?: string;
  organizationId?: string;
}): Turnkey {
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
 * Send OTP code to email via Turnkey
 */
export async function initOtp(
  turnkeyClient: Turnkey,
  email: string,
  subOrgId?: string
): Promise<string> {
  try {
    const result = await turnkeyClient.apiClient().initOtp({
      otpType: 'OTP_TYPE_EMAIL',
      contact: email,
      appName: 'Originals',
      ...(subOrgId ? { organizationId: subOrgId } : {}),
    });

    const otpId = result.otpId;
    if (!otpId) {
      throw new Error('No OTP ID returned from Turnkey');
    }

    return otpId;
  } catch (error) {
    console.error('Error initializing OTP:', error);
    throw new Error(
      `Failed to send OTP: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Complete OTP verification flow
 * Returns verification token and sub-org ID
 */
export async function completeOtp(
  turnkeyClient: Turnkey,
  otpId: string,
  otpCode: string,
  subOrgId: string
): Promise<{ verificationToken: string; subOrgId: string }> {
  try {
    const result = await turnkeyClient.apiClient().verifyOtp({
      otpId,
      otpCode,
      expirationSeconds: '900',
      organizationId: subOrgId,
    });

    if (!result.verificationToken) {
      throw new Error('OTP verification failed - no verification token returned');
    }

    return {
      verificationToken: result.verificationToken,
      subOrgId,
    };
  } catch (error) {
    console.error('Error completing OTP:', error);
    throw new Error(
      `Failed to complete OTP: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Fetch users in a sub-organization
 */
export async function fetchUser(
  turnkeyClient: Turnkey,
  subOrgId: string,
  onExpired?: () => void
): Promise<unknown> {
  return withTokenExpiration(async () => {
    try {
      const response = await turnkeyClient.apiClient().getUsers({
        organizationId: subOrgId,
      });
      const users = response.users ?? [];
      return users[0] ?? null;
    } catch (error) {
      console.error('Error fetching user:', error);
      throw new Error(
        `Failed to fetch user: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, onExpired);
}

/**
 * Fetch user's wallets with accounts
 */
export async function fetchWallets(
  turnkeyClient: Turnkey,
  subOrgId: string,
  onExpired?: () => void
): Promise<TurnkeyWallet[]> {
  return withTokenExpiration(async () => {
    try {
      const response = await turnkeyClient.apiClient().getWallets({
        organizationId: subOrgId,
      });

      const wallets: TurnkeyWallet[] = [];

      for (const wallet of response.wallets || []) {
        const accountsResponse = await turnkeyClient.apiClient().getWalletAccounts({
          organizationId: subOrgId,
          walletId: wallet.walletId,
        });

        wallets.push({
          walletId: wallet.walletId,
          walletName: wallet.walletName,
          accounts: (accountsResponse.accounts || []).map(
            (acc: { address: string; curve: string; path: string; addressFormat: string }) => ({
              address: acc.address,
              curve: acc.curve as 'CURVE_SECP256K1' | 'CURVE_ED25519',
              path: acc.path,
              addressFormat: acc.addressFormat,
            })
          ),
        });
      }

      return wallets;
    } catch (error) {
      console.error('Error fetching wallets:', error);
      throw new Error(
        `Failed to fetch wallets: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, onExpired);
}

/**
 * Get key by curve type from wallets
 */
export function getKeyByCurve(
  wallets: TurnkeyWallet[],
  curve: 'CURVE_SECP256K1' | 'CURVE_ED25519'
): TurnkeyWalletAccount | null {
  for (const wallet of wallets) {
    for (const account of wallet.accounts) {
      if (account.curve === curve) {
        return account;
      }
    }
  }
  return null;
}

/**
 * Create a wallet with the required accounts for DID creation
 */
export async function createWalletWithAccounts(
  turnkeyClient: Turnkey,
  subOrgId: string,
  onExpired?: () => void
): Promise<TurnkeyWallet> {
  return withTokenExpiration(async () => {
    try {
      const response = await turnkeyClient.apiClient().createWallet({
        walletName: 'default-wallet',
        accounts: [
          {
            curve: 'CURVE_SECP256K1',
            pathFormat: 'PATH_FORMAT_BIP32',
            path: "m/44'/0'/0'/0/0",
            addressFormat: 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR',
          },
          {
            curve: 'CURVE_ED25519',
            pathFormat: 'PATH_FORMAT_BIP32',
            path: "m/44'/501'/0'/0'",
            addressFormat: 'ADDRESS_FORMAT_SOLANA',
          },
          {
            curve: 'CURVE_ED25519',
            pathFormat: 'PATH_FORMAT_BIP32',
            path: "m/44'/501'/1'/0'",
            addressFormat: 'ADDRESS_FORMAT_SOLANA',
          },
        ],
        organizationId: subOrgId,
      });

      const walletId = response.walletId;
      if (!walletId) {
        throw new Error('No wallet ID returned from createWallet');
      }

      // Wait for wallet to be created, then fetch it
      await new Promise((resolve) => setTimeout(resolve, 500));

      const wallets = await fetchWallets(turnkeyClient, subOrgId, onExpired);
      const createdWallet = wallets.find((w) => w.walletId === walletId);

      if (!createdWallet) {
        throw new Error('Failed to fetch created wallet');
      }

      return createdWallet;
    } catch (error) {
      console.error('Error creating wallet:', error);
      throw new Error(
        `Failed to create wallet: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, onExpired);
}

/**
 * Ensure user has a wallet with the required accounts for DID creation
 */
export async function ensureWalletWithAccounts(
  turnkeyClient: Turnkey,
  subOrgId: string,
  onExpired?: () => void
): Promise<TurnkeyWallet[]> {
  return withTokenExpiration(async () => {
    try {
      let wallets = await fetchWallets(turnkeyClient, subOrgId, onExpired);

      if (wallets.length === 0) {
        console.log('No wallets found, creating new wallet with accounts...');
        const newWallet = await createWalletWithAccounts(turnkeyClient, subOrgId, onExpired);
        wallets = [newWallet];
        return wallets;
      }

      const defaultWallet = wallets[0];
      const allAccounts = defaultWallet.accounts;
      const secp256k1Accounts = allAccounts.filter((acc) => acc.curve === 'CURVE_SECP256K1');
      const ed25519Accounts = allAccounts.filter((acc) => acc.curve === 'CURVE_ED25519');

      // Check if we need more accounts
      if (secp256k1Accounts.length >= 1 && ed25519Accounts.length >= 2) {
        return wallets;
      }

      // Need to create additional accounts
      const accountsToCreate: Array<{
        curve: 'CURVE_SECP256K1' | 'CURVE_ED25519';
        pathFormat: 'PATH_FORMAT_BIP32';
        path: string;
        addressFormat: 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR' | 'ADDRESS_FORMAT_SOLANA';
      }> = [];

      if (secp256k1Accounts.length === 0) {
        accountsToCreate.push({
          curve: 'CURVE_SECP256K1',
          pathFormat: 'PATH_FORMAT_BIP32',
          path: "m/44'/0'/0'/0/0",
          addressFormat: 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR',
        });
      }

      const ed25519Needed = 2 - ed25519Accounts.length;
      for (let i = 0; i < ed25519Needed; i++) {
        const pathIndex = ed25519Accounts.length + i;
        accountsToCreate.push({
          curve: 'CURVE_ED25519',
          pathFormat: 'PATH_FORMAT_BIP32',
          path: pathIndex === 0 ? "m/44'/501'/0'/0'" : "m/44'/501'/1'/0'",
          addressFormat: 'ADDRESS_FORMAT_SOLANA',
        });
      }

      if (accountsToCreate.length > 0) {
        console.log(`Creating ${accountsToCreate.length} missing account(s)...`);
        await turnkeyClient.apiClient().createWalletAccounts({
          walletId: defaultWallet.walletId,
          accounts: accountsToCreate,
          organizationId: subOrgId,
        });

        wallets = await fetchWallets(turnkeyClient, subOrgId, onExpired);
      }

      return wallets;
    } catch (error) {
      console.error('Error ensuring wallet with accounts:', error);
      throw new Error(
        `Failed to ensure wallet with accounts: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, onExpired);
}
