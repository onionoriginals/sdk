/**
 * Turnkey Client Utilities
 * Handles Turnkey client initialization and authentication flow
 */

import { OtpType, TurnkeyClient, WalletAccount } from '@turnkey/core';
import { withTokenExpiration } from './turnkey-error-handler';

export interface TurnkeyWallet {
  walletId: string;
  walletName: string;
  accounts: WalletAccount[];
}

export interface TurnkeyAuthState {
  email: string;
  subOrgId: string;
  client: TurnkeyClient;
  wallets: TurnkeyWallet[];
}

/**
 * Initialize Turnkey client with auth proxy configuration
 */
export function initializeTurnkeyClient(): TurnkeyClient {
  const authProxyConfigId = import.meta.env.VITE_TURNKEY_AUTH_PROXY_CONFIG_ID;
  const organizationId = import.meta.env.VITE_TURNKEY_ORGANIZATION_ID;

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
export async function initOtp(
  turnkeyClient: TurnkeyClient,
  email: string
): Promise<string> {
  try {
    const response = await turnkeyClient.initOtp({
      otpType: OtpType.Email,
      contact: email
    });

    if (!response || typeof response !== 'string') {
      throw new Error('No OTP ID returned from Turnkey');
    }

    return response;
  } catch (error) {
    console.error('Error initializing OTP:', error);
    throw new Error(`Failed to send OTP: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Complete OTP authentication flow (verifies OTP and logs in/signs up)
 * This combines verification and login/signup into a single call
 * @see https://docs.turnkey.com/generated-docs/formatted/core/turnkey-client-complete-otp#completeotp
 */
export async function completeOtp(
  turnkeyClient: TurnkeyClient,
  otpId: string,
  otpCode: string,
  email: string
): Promise<{ sessionToken: string; userId: string; action: 'login' | 'signup' }> {
  try {
    // Complete OTP flow - verifies code and handles login/signup automatically
    const response = await turnkeyClient.completeOtp({
      otpId,
      otpCode,
      contact: email,
      otpType: OtpType.Email,
    });

    console.log('response', response);
    if (!response.sessionToken) {
      throw new Error('No session token returned from completeOtp');
    }

    // Fetch user info to get stable identifiers
    const userInfo = await turnkeyClient.fetchUser();

    return {
      sessionToken: response.sessionToken,
      userId: userInfo.userId,
      action: response.action === 'LOGIN' ? 'login' : 'signup',
    };
  } catch (error) {
    console.error('Error completing OTP:', error);
    throw new Error(`Failed to complete OTP: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetch user information
 */
export async function fetchUser(
  turnkeyClient: TurnkeyClient,
  onExpired?: () => void
): Promise<any> {
  return withTokenExpiration(async () => {
    try {
      const response = await turnkeyClient.fetchUser();
      return response;
    } catch (error) {
      console.error('Error fetching user:', error);
      throw new Error(`Failed to fetch user: ${error instanceof Error ? error.message : String(error)}`);
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
          accounts: accountsResponse,
        });
      }

      return wallets;
    } catch (error) {
      console.error('Error fetching wallets:', error);
      throw new Error(`Failed to fetch wallets: ${error instanceof Error ? error.message : String(error)}`);
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
        return account;
      }
    }
  }
  return null;
}

/**
 * Complete authentication flow
 */
export async function authenticateWithEmail(
  email: string
): Promise<TurnkeyAuthState> {
  const turnkeyClient = initializeTurnkeyClient();

  // This is a simplified version - in practice, you'll need to:
  // 1. Call initOtp to send the code
  // 2. Let user enter the code
  // 3. Call completeOtp to verify and login/signup
  // 4. Fetch wallets

  throw new Error('Use initOtp and completeOtp separately for proper flow');
}
