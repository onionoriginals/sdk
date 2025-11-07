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
 * Create a wallet with the required accounts for DID creation
 * Accounts: 1 Secp256k1 (auth key) and 2 Ed25519 (assertion key, update key)
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
            path: "m/44'/0'/0'/0/0", // Standard Bitcoin path for auth-key
            addressFormat: 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR', // Secp256k1 - use Ethereum format
          },
          {
            curve: 'CURVE_ED25519',
            pathFormat: 'PATH_FORMAT_BIP32',
            path: "m/44'/501'/0'/0'", // Standard Solana path (Ed25519) for assertion-key
            addressFormat: 'ADDRESS_FORMAT_SOLANA', // Ed25519 - use Solana format
          },
          {
            curve: 'CURVE_ED25519',
            pathFormat: 'PATH_FORMAT_BIP32',
            path: "m/44'/501'/1'/0'", // Different path for update-key
            addressFormat: 'ADDRESS_FORMAT_SOLANA', // Ed25519 - use Solana format
          },
        ],
      });

      // The response might be a string (walletId) or an object with walletId property
      let walletId: string;
      if (typeof response === 'string') {
        walletId = response;
      } else {
        walletId = (response as any)?.walletId;
      }
      if (!walletId) {
        throw new Error('No wallet ID returned from createWallet');
      }

      // Wait a moment for the wallet to be fully created, then fetch it
      await new Promise(resolve => setTimeout(resolve, 500));

      // Fetch the created wallet with accounts
      const wallets = await fetchWallets(turnkeyClient, onExpired);
      const createdWallet = wallets.find(w => w.walletId === walletId);
      
      if (!createdWallet) {
        throw new Error('Failed to fetch created wallet');
      }

      return createdWallet;
    } catch (error) {
      console.error('Error creating wallet:', error);
      throw new Error(`Failed to create wallet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, onExpired);
}

/**
 * Create additional accounts in an existing wallet
 * Used when a wallet exists but doesn't have enough accounts
 */
export async function createWalletAccounts(
  turnkeyClient: TurnkeyClient,
  walletId: string,
  accountsToCreate: Array<{
    curve: 'CURVE_SECP256K1' | 'CURVE_ED25519';
    pathFormat: 'PATH_FORMAT_BIP32';
    path: string;
    addressFormat: 'ADDRESS_FORMAT_ETHEREUM' | 'ADDRESS_FORMAT_SOLANA';
  }>,
  onExpired?: () => void
): Promise<void> {
  return withTokenExpiration(async () => {
    try {
      await turnkeyClient.createWalletAccounts({
        walletId,
        accounts: accountsToCreate,
      });
    } catch (error) {
      console.error('Error creating wallet accounts:', error);
      throw new Error(`Failed to create wallet accounts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, onExpired);
}

/**
 * Ensure user has a wallet with the required accounts for DID creation
 * Creates wallet/accounts if they don't exist
 */
export async function ensureWalletWithAccounts(
  turnkeyClient: TurnkeyClient,
  onExpired?: () => void
): Promise<TurnkeyWallet[]> {
  return withTokenExpiration(async () => {
    try {
      // Fetch existing wallets
      let wallets = await fetchWallets(turnkeyClient, onExpired);

      // If no wallets exist, create one with all required accounts
      if (wallets.length === 0) {
        console.log('No wallets found, creating new wallet with accounts...');
        const newWallet = await createWalletWithAccounts(turnkeyClient, onExpired);
        wallets = [newWallet];
        return wallets;
      }

      // Check if we have a wallet with enough accounts
      const defaultWallet = wallets[0];
      const allAccounts = defaultWallet.accounts;
      const secp256k1Accounts = allAccounts.filter(acc => acc.curve === 'CURVE_SECP256K1');
      const ed25519Accounts = allAccounts.filter(acc => acc.curve === 'CURVE_ED25519');

      // We need: 1 Secp256k1 and 2 Ed25519
      const accountsToCreate: Array<{
        curve: 'CURVE_SECP256K1' | 'CURVE_ED25519';
        pathFormat: 'PATH_FORMAT_BIP32';
        path: string;
        addressFormat: 'ADDRESS_FORMAT_ETHEREUM' | 'ADDRESS_FORMAT_SOLANA';
      }> = [];

      // Add missing Secp256k1 account if needed
      if (secp256k1Accounts.length === 0) {
        accountsToCreate.push({
          curve: 'CURVE_SECP256K1',
          pathFormat: 'PATH_FORMAT_BIP32',
          path: "m/44'/0'/0'/0/0",
          addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
        });
      }

      // Add missing Ed25519 accounts if needed (need 2 total)
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

      // Create missing accounts if any
      if (accountsToCreate.length > 0) {
        console.log(`Creating ${accountsToCreate.length} missing account(s)...`);
        await createWalletAccounts(turnkeyClient, defaultWallet.walletId, accountsToCreate, onExpired);
        
        // Refetch wallets to get updated accounts
        wallets = await fetchWallets(turnkeyClient, onExpired);
      }

      return wallets;
    } catch (error) {
      console.error('Error ensuring wallet with accounts:', error);
      throw new Error(`Failed to ensure wallet with accounts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, onExpired);
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
