/**
 * Client-side Turnkey utilities
 * Handles Turnkey client initialization and authentication flow in the browser
 */

import { TurnkeyClient, OtpType, WalletAccount } from '@turnkey/core';
import type { TurnkeyWallet } from '../types';

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
 * Initialize Turnkey client with auth proxy configuration
 */
export function initializeTurnkeyClient(): TurnkeyClient {
  // Access Vite environment variables
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const authProxyConfigId = env?.VITE_TURNKEY_AUTH_PROXY_CONFIG_ID;
  const organizationId = env?.VITE_TURNKEY_ORGANIZATION_ID ?? '';

  if (!authProxyConfigId) {
    throw new Error('VITE_TURNKEY_AUTH_PROXY_CONFIG_ID environment variable not set');
  }

  return new TurnkeyClient({
    authProxyConfigId,
    organizationId,
  });
}

/**
 * Send OTP code to email
 */
export async function initOtp(turnkeyClient: TurnkeyClient, email: string): Promise<string> {
  try {
    const response = await turnkeyClient.initOtp({
      otpType: OtpType.Email,
      contact: email,
    });

    if (!response || typeof response !== 'string') {
      throw new Error('No OTP ID returned from Turnkey');
    }

    return response;
  } catch (error) {
    console.error('Error initializing OTP:', error);
    throw new Error(
      `Failed to send OTP: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Complete OTP authentication flow (verifies OTP and logs in/signs up)
 */
export async function completeOtp(
  turnkeyClient: TurnkeyClient,
  otpId: string,
  otpCode: string,
  email: string
): Promise<{ sessionToken: string; userId: string; action: 'login' | 'signup' }> {
  try {
    const response = await turnkeyClient.completeOtp({
      otpId,
      otpCode,
      contact: email,
      otpType: OtpType.Email,
    });

    if (!response.sessionToken) {
      throw new Error('No session token returned from completeOtp');
    }

    // Fetch user info to get stable identifiers
    const userInfo = await turnkeyClient.fetchUser();

    return {
      sessionToken: response.sessionToken,
      userId: userInfo.userId,
      action: String(response.action) === 'LOGIN' ? 'login' : 'signup',
    };
  } catch (error) {
    console.error('Error completing OTP:', error);
    throw new Error(
      `Failed to complete OTP: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Fetch user information
 */
export async function fetchUser(
  turnkeyClient: TurnkeyClient,
  onExpired?: () => void
): Promise<unknown> {
  return withTokenExpiration(async () => {
    try {
      const response = await turnkeyClient.fetchUser();
      return response;
    } catch (error) {
      console.error('Error fetching user:', error);
      throw new Error(
        `Failed to fetch user: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, onExpired);
}

/**
 * Fetch user's wallets
 */
export async function fetchWallets(
  turnkeyClient: TurnkeyClient,
  onExpired?: () => void
): Promise<TurnkeyWallet[]> {
  return withTokenExpiration(async () => {
    try {
      const response = await turnkeyClient.fetchWallets();

      const wallets: TurnkeyWallet[] = [];

      for (const wallet of response || []) {
        const accountsResponse = await turnkeyClient.fetchWalletAccounts({
          wallet: wallet,
        });

        wallets.push({
          walletId: wallet.walletId,
          walletName: wallet.walletName,
          accounts: accountsResponse.map((acc: WalletAccount) => ({
            address: acc.address,
            curve: acc.curve as 'CURVE_SECP256K1' | 'CURVE_ED25519',
            path: acc.path,
            addressFormat: acc.addressFormat,
          })),
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
 * Get key by curve type
 */
export function getKeyByCurve(
  wallets: TurnkeyWallet[],
  curve: 'CURVE_SECP256K1' | 'CURVE_ED25519'
): WalletAccount | null {
  for (const wallet of wallets) {
    for (const account of wallet.accounts) {
      if (account.curve === curve) {
        return account as unknown as WalletAccount;
      }
    }
  }
  return null;
}

/**
 * Create a wallet with the required accounts for DID creation
 */
export async function createWalletWithAccounts(
  turnkeyClient: TurnkeyClient,
  onExpired?: () => void
): Promise<TurnkeyWallet> {
  return withTokenExpiration(async () => {
    try {
      const response = await turnkeyClient.createWallet({
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
      });

      let walletId: string;
      if (typeof response === 'string') {
        walletId = response;
      } else {
        walletId = (response as { walletId?: string })?.walletId ?? '';
      }

      if (!walletId) {
        throw new Error('No wallet ID returned from createWallet');
      }

      // Wait for wallet to be created, then fetch it
      await new Promise((resolve) => setTimeout(resolve, 500));

      const wallets = await fetchWallets(turnkeyClient, onExpired);
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
  turnkeyClient: TurnkeyClient,
  onExpired?: () => void
): Promise<TurnkeyWallet[]> {
  return withTokenExpiration(async () => {
    try {
      let wallets = await fetchWallets(turnkeyClient, onExpired);

      if (wallets.length === 0) {
        console.log('No wallets found, creating new wallet with accounts...');
        const newWallet = await createWalletWithAccounts(turnkeyClient, onExpired);
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
        await turnkeyClient.createWalletAccounts({
          walletId: defaultWallet.walletId,
          accounts: accountsToCreate,
        });

        wallets = await fetchWallets(turnkeyClient, onExpired);
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

