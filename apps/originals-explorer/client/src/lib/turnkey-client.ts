/**
 * Turnkey Client Utilities
 * Handles Turnkey client initialization and authentication flow
 */

import { OtpType, TurnkeyClient, WalletAccount } from '@turnkey/core';

export interface TurnkeyWalletAccount {
  accountId: string;
  address: string;
  curve: string;
  path: string;
  addressFormat: string;
}

export interface TurnkeyWallet {
  walletId: string;
  walletName: string;
  accounts: TurnkeyWalletAccount[];
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
 * Verify OTP code
 */
export async function verifyOtp(
  turnkeyClient: TurnkeyClient,
  otpId: string,
  otpCode: string,
  email: string
): Promise<string> {
  try {
    const response = await turnkeyClient.verifyOtp({
      otpId,
      otpCode,
      contact: email,
      otpType: OtpType.Email,
    });

    if (!response.verificationToken) {
      throw new Error('No verification token returned from Turnkey');
    }

    return response.verificationToken;
  } catch (error) {
    console.error('Error verifying OTP:', error);
    throw new Error(`Failed to verify OTP: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Complete login with verified OTP and fetch user info
 */
export async function loginWithOtp(
  turnkeyClient: TurnkeyClient,
  email: string,
  verificationToken: string
): Promise<{ sessionToken: string; userId: string; organizationId: string }> {
  try {
    // Login with the verification token
    const loginResponse = await turnkeyClient.loginWithOtp({
      verificationToken,
    });

    if (!loginResponse.sessionToken) {
      throw new Error('No session token returned from login');
    }

    // Fetch user info to get stable identifiers
    const userInfo = await turnkeyClient.fetchUser();

    console.log('Turnkey user info:', userInfo);

    if (!userInfo?.organizationId) {
      throw new Error('No organization ID returned from Turnkey');
    }

    return {
      sessionToken: loginResponse.sessionToken,
      userId: userInfo.userId || userInfo.organizationId, // Fallback to orgId if userId not present
      organizationId: userInfo.organizationId,
    };
  } catch (error) {
    console.error('Error logging in with OTP:', error);
    throw new Error(`Failed to login: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetch user information
 */
export async function fetchUser(
  turnkeyClient: TurnkeyClient
): Promise<any> {
  try {
    const response = await turnkeyClient.fetchUser();

    return response;
  } catch (error) {
    console.error('Error fetching user:', error);
    throw new Error(`Failed to fetch user: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetch user's wallets
 */
export async function fetchWallets(
  turnkeyClient: TurnkeyClient
): Promise<TurnkeyWallet[]> {
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
        accounts: accountsResponse.map((account: WalletAccount) => ({
          accountId: account.walletAccountId,
          address: account.address,
          curve: account.curve,
          path: account.path,
          addressFormat: account.addressFormat,
        })),
      });
    }

    return wallets;
  } catch (error) {
    console.error('Error fetching wallets:', error);
    throw new Error(`Failed to fetch wallets: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get key by curve type
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
 * Complete authentication flow
 */
export async function authenticateWithEmail(
  email: string
): Promise<TurnkeyAuthState> {
  const turnkeyClient = initializeTurnkeyClient();

  // This is a simplified version - in practice, you'll need to:
  // 1. Call initOtp to send the code
  // 2. Let user enter the code
  // 3. Call verifyOtp
  // 4. Call loginWithOtp
  // 5. Fetch wallets

  throw new Error('Use initOtp, verifyOtp, and loginWithOtp separately for proper flow');
}
