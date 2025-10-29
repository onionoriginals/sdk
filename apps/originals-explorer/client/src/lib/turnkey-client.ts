/**
 * Turnkey Client Utilities
 * Handles Turnkey client initialization and authentication flow
 */

import { Turnkey } from '@turnkey/sdk-browser';

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
  client: Turnkey;
  wallets: TurnkeyWallet[];
}

/**
 * Initialize Turnkey client with auth proxy configuration
 */
export function initializeTurnkeyClient(): Turnkey {
  const authProxyConfigId = import.meta.env.VITE_TURNKEY_AUTH_PROXY_CONFIG_ID;

  if (!authProxyConfigId) {
    throw new Error('VITE_TURNKEY_AUTH_PROXY_CONFIG_ID environment variable not set');
  }

  return new Turnkey({
    authProxyConfigId,
    defaultOrganizationId: '', // Will be set after login
  });
}

/**
 * Send OTP code to email
 */
export async function initOtp(
  turnkeyClient: Turnkey,
  email: string
): Promise<string> {
  try {
    const response = await turnkeyClient.passkeyClient().initOtp({
      otpType: 'OTP_TYPE_EMAIL',
      contact: email,
      emailCustomization: {
        appName: 'Originals Explorer',
      },
      otpLength: 6,
      alphanumeric: false,
    });

    if (!response.otpId) {
      throw new Error('No OTP ID returned from Turnkey');
    }

    return response.otpId;
  } catch (error) {
    console.error('Error initializing OTP:', error);
    throw new Error(`Failed to send OTP: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Verify OTP code
 */
export async function verifyOtp(
  turnkeyClient: Turnkey,
  otpId: string,
  otpCode: string
): Promise<string> {
  try {
    const response = await turnkeyClient.passkeyClient().verifyOtp({
      otpId,
      otpCode,
      expirationSeconds: '900', // 15 minutes
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
 * Complete login with verified OTP
 */
export async function loginWithOtp(
  turnkeyClient: Turnkey,
  email: string,
  verificationToken: string
): Promise<{ subOrgId: string }> {
  try {
    // Login with the verification token
    const loginResponse = await turnkeyClient.passkeyClient().loginWithVerificationToken({
      verificationToken,
    });

    if (!loginResponse.organizationId) {
      throw new Error('No organization ID returned from login');
    }

    // Set the default organization ID for future requests
    turnkeyClient.config.defaultOrganizationId = loginResponse.organizationId;

    return {
      subOrgId: loginResponse.organizationId,
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
  turnkeyClient: Turnkey
): Promise<any> {
  try {
    const response = await turnkeyClient.apiClient().getWhoami({
      organizationId: turnkeyClient.config.defaultOrganizationId!,
    });

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
  turnkeyClient: Turnkey
): Promise<TurnkeyWallet[]> {
  try {
    const response = await turnkeyClient.apiClient().getWallets({
      organizationId: turnkeyClient.config.defaultOrganizationId!,
    });

    const wallets: TurnkeyWallet[] = [];

    for (const wallet of response.wallets || []) {
      const accountsResponse = await turnkeyClient.apiClient().getWalletAccounts({
        organizationId: turnkeyClient.config.defaultOrganizationId!,
        walletId: wallet.walletId,
      });

      const accounts: TurnkeyWalletAccount[] = (accountsResponse.accounts || []).map(account => ({
        accountId: account.accountId,
        address: account.address,
        curve: account.curve,
        path: account.path,
        addressFormat: account.addressFormat,
      }));

      wallets.push({
        walletId: wallet.walletId,
        walletName: wallet.walletName,
        accounts,
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
