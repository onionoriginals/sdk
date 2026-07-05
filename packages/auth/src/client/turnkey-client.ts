/**
 * Client-side Turnkey utilities
 * Uses @turnkey/sdk-server for all Turnkey operations (no viem/ethers dependency)
 */

import { Turnkey } from '@turnkey/sdk-server';
import { encryptOtpCode } from '../otp-encryption.js';
import type { TurnkeyWallet, TurnkeyWalletAccount } from '../types.js';

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
 * @deprecated This function reads server-grade org API secrets and must not be
 * used in client-side code. It has been removed from the client module to
 * enforce the server/client boundary.
 *
 * Use `createTurnkeyClient` from `@originals/auth/server` instead.
 *
 * BREAKING CHANGE: This shim throws at call time. It will be removed in a
 * future major release.
 */
export function initializeTurnkeyClient(
  _config?: Record<string, unknown>
): never {
  throw new Error(
    'initializeTurnkeyClient has been removed from the client module because it reads ' +
      'server-only org API secrets. ' +
      'Use createTurnkeyClient from @originals/auth/server instead.'
  );
}

/**
 * Result of initiating an OTP flow via {@link initOtp}.
 */
export interface InitOtpResult {
  /** Unique identifier for the OTP flow. */
  otpId: string;
  /**
   * Signed bundle containing the target encryption key. The OTP code must be
   * encrypted to this bundle when calling {@link completeOtp} (Turnkey v6
   * encrypted-bundle flow).
   */
  otpEncryptionTargetBundle: string;
}

/**
 * Options for {@link completeOtp}.
 */
export interface CompleteOtpOptions {
  /**
   * Optional compressed P-256 public key (hex) to embed in the encrypted OTP
   * bundle. When omitted, an ephemeral key pair is generated and returned.
   */
  publicKey?: string;
  /**
   * Override for the enclave signing key used to verify the target bundle's
   * signature. ONLY for tests or non-production Turnkey environments.
   */
  dangerouslyOverrideSignerPublicKey?: string;
}

/**
 * Result of completing an OTP flow via {@link completeOtp}.
 */
export interface CompleteOtpResult {
  /** Verification token issued by Turnkey (consumed by OTP_LOGIN). */
  verificationToken: string;
  /** Turnkey sub-organization ID. */
  subOrgId: string;
  /**
   * Compressed P-256 public key (hex) that the verification token is bound
   * to. Pass this as `publicKey` to a subsequent `otpLogin` activity.
   */
  publicKey: string;
  /**
   * Private key (hex) for the ephemeral key pair, present only when no
   * `publicKey` option was supplied. Needed to prove possession of the bound
   * key in subsequent requests. Sensitive: never log or persist insecurely.
   */
  privateKey?: string;
}

/**
 * Send OTP code to email via Turnkey.
 *
 * Returns the OTP ID together with the `otpEncryptionTargetBundle`, which is
 * required by {@link completeOtp} to encrypt the OTP code (Turnkey v6 no
 * longer accepts plaintext OTP codes on verification).
 */
export async function initOtp(
  turnkeyClient: Turnkey,
  email: string,
  subOrgId?: string
): Promise<InitOtpResult> {
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

    const otpEncryptionTargetBundle = result.otpEncryptionTargetBundle;
    if (!otpEncryptionTargetBundle) {
      throw new Error('No OTP encryption target bundle returned from Turnkey');
    }

    return { otpId, otpEncryptionTargetBundle };
  } catch (error) {
    console.error('Error initializing OTP:', error);
    throw new Error(
      `Failed to send OTP: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Complete OTP verification flow (Turnkey v6 encrypted-bundle flow).
 *
 * Encrypts the user-supplied OTP code (plus a client-generated P-256 public
 * key) to the `otpEncryptionTargetBundle` returned by {@link initOtp}, then
 * submits it as `encryptedOtpBundle` to Turnkey's `verifyOtp` activity.
 *
 * Returns the verification token, the sub-org ID, and the key pair the token
 * is bound to (for use with a subsequent `otpLogin`).
 */
export async function completeOtp(
  turnkeyClient: Turnkey,
  otpId: string,
  otpCode: string,
  subOrgId: string,
  otpEncryptionTargetBundle: string,
  options?: CompleteOtpOptions
): Promise<CompleteOtpResult> {
  try {
    const { encryptedOtpBundle, publicKey, privateKey } = await encryptOtpCode({
      otpCode,
      otpEncryptionTargetBundle,
      publicKey: options?.publicKey,
      dangerouslyOverrideSignerPublicKey: options?.dangerouslyOverrideSignerPublicKey,
    });

    const result = await turnkeyClient.apiClient().verifyOtp({
      otpId,
      encryptedOtpBundle,
      expirationSeconds: '900',
      organizationId: subOrgId,
    });

    if (!result.verificationToken) {
      throw new Error('OTP verification failed - no verification token returned');
    }

    return {
      verificationToken: result.verificationToken,
      subOrgId,
      publicKey,
      privateKey,
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
