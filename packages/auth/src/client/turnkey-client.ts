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
 * Collect searchable text from an error: its message, its JSON
 * serialization, and the same for every error in its `cause` chain.
 *
 * `JSON.stringify` alone is not enough — for a plain `Error` it yields
 * `"{}"` because `message`/`stack` are non-enumerable, and the wrapped
 * client functions rethrow plain `Error`s around the original
 * `TurnkeyRequestError`.
 */
function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      try {
        parts.push(JSON.stringify(current));
      } catch {
        // circular structure - message already captured
      }
      current = current.cause;
    } else {
      try {
        parts.push(typeof current === 'string' ? current : JSON.stringify(current) ?? '');
      } catch {
        // circular structure
      }
      break;
    }
  }
  return parts.join(' ').toLowerCase();
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
    const errorStr = collectErrorText(error);
    if (
      errorStr.includes('api_key_expired') ||
      errorStr.includes('expired api key') ||
      errorStr.includes('"code":16')
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
   * Organization ID to run the verifyOtp activity under. Must match the org
   * context that ran {@link initOtp} — Turnkey scopes the OTP flow to the
   * initiating organization. Leave unset (parent org, the client's default)
   * unless `initOtp` was explicitly routed to another organization.
   */
  organizationId?: string;
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
 *
 * Turnkey's documented flow runs initOtp/verifyOtp under the parent
 * organization (the client's default org) and uses the sub-org only for the
 * subsequent `otpLogin`; leave `subOrgId` unset unless you know the flow
 * must be scoped otherwise, and mirror whatever org context you use here in
 * {@link completeOtp} via `options.organizationId`.
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
      `Failed to send OTP: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
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
 *
 * The verifyOtp activity runs under the same org context as {@link initOtp}
 * (the parent org by default). `subOrgId` identifies the user's
 * sub-organization for the subsequent `otpLogin` and is echoed back in the
 * result; it is NOT used to route the verification itself — pass
 * `options.organizationId` only if `initOtp` was explicitly scoped to a
 * different organization.
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
      // Align org context with initOtp (Turnkey scopes otpId to the
      // initiating org). Defaults to the client's default (parent) org.
      ...(options?.organizationId ? { organizationId: options.organizationId } : {}),
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
      `Failed to complete OTP: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
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
        `Failed to fetch user: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
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
        `Failed to fetch wallets: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }, onExpired);
}

/**
 * Get key by curve type from wallets.
 *
 * Returns the first account matching `curve`, in wallet/account order. This
 * cannot distinguish between two accounts that share a curve — the wallet
 * layout this package provisions has exactly that case (both the DID
 * assertion-key and update-key are `CURVE_ED25519`) — so for `CURVE_ED25519`
 * this returns whichever of the two happens to come first in the API
 * response (not reliably the assertion-key: Turnkey's account order is not
 * a guaranteed contract), and there is no way to select the other one
 * through this function. Use {@link getKeyByRole} to select a specific
 * DID-signing account by its exact role instead.
 *
 * Kept for backward compatibility with callers that only need a single
 * account of a given curve (e.g. the Bitcoin auth-key, which is the only
 * `CURVE_SECP256K1` account).
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
 * Canonical roles for the Turnkey accounts this package provisions and
 * depends on. A role is identified by its exact curve **and** derivation
 * path, not curve alone, so that two same-curve accounts (the DID
 * assertion-key and update-key are both `CURVE_ED25519`) can be told apart.
 */
export type TurnkeyAccountRole = 'bitcoin-auth' | 'did-assertion' | 'did-update';

interface TurnkeyAccountRoleSpec {
  readonly role: TurnkeyAccountRole;
  readonly curve: 'CURVE_SECP256K1' | 'CURVE_ED25519';
  readonly path: string;
  readonly addressFormat: 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR' | 'ADDRESS_FORMAT_SOLANA';
}

/**
 * The single source of truth for the wallet layout `createWalletWithAccounts`
 * provisions and `ensureWalletWithAccounts`/`getKeyByRole` depend on:
 * - `bitcoin-auth` — the Bitcoin auth-key (`CURVE_SECP256K1`).
 * - `did-assertion` — the DID assertion-key (`CURVE_ED25519`).
 * - `did-update` — the DID update-key (`CURVE_ED25519`, a distinct path from
 *   `did-assertion` so the two can be resolved independently).
 *
 * Frozen (entries included) so a caller can't mutate the table that every
 * lookup and repair path in this module relies on.
 */
const TURNKEY_ACCOUNT_ROLE_SPECS: TurnkeyAccountRoleSpec[] = [
  {
    role: 'bitcoin-auth',
    curve: 'CURVE_SECP256K1',
    path: "m/44'/0'/0'/0/0",
    addressFormat: 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR',
  },
  {
    role: 'did-assertion',
    curve: 'CURVE_ED25519',
    path: "m/44'/501'/0'/0'",
    addressFormat: 'ADDRESS_FORMAT_SOLANA',
  },
  {
    role: 'did-update',
    curve: 'CURVE_ED25519',
    path: "m/44'/501'/1'/0'",
    addressFormat: 'ADDRESS_FORMAT_SOLANA',
  },
];

export const TURNKEY_ACCOUNT_ROLES: readonly TurnkeyAccountRoleSpec[] = Object.freeze(
  TURNKEY_ACCOUNT_ROLE_SPECS.map((spec) => Object.freeze({ ...spec }))
);

/**
 * Get a wallet account by its canonical role (curve + exact derivation
 * path), not merely by curve. Use this to fetch the DID assertion-key or
 * update-key specifically — `getKeyByCurve('CURVE_ED25519')` cannot tell
 * them apart, since both share that curve.
 */
export function getKeyByRole(
  wallets: TurnkeyWallet[],
  role: TurnkeyAccountRole
): TurnkeyWalletAccount | null {
  const spec = TURNKEY_ACCOUNT_ROLES.find((r) => r.role === role);
  if (!spec) {
    return null;
  }
  for (const wallet of wallets) {
    for (const account of wallet.accounts) {
      if (account.curve === spec.curve && account.path === spec.path) {
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
        accounts: TURNKEY_ACCOUNT_ROLES.map((spec) => ({
          curve: spec.curve,
          pathFormat: 'PATH_FORMAT_BIP32' as const,
          path: spec.path,
          addressFormat: spec.addressFormat,
        })),
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
        `Failed to create wallet: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
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

      // Check for each required role by its exact curve + path, not by
      // curve count: two accounts can share a curve (both DID-signing
      // accounts are CURVE_ED25519), so a wallet holding two Ed25519
      // accounts at the *wrong* paths would otherwise be miscounted as
      // complete while neither required role is actually provisioned.
      const missingRoles = TURNKEY_ACCOUNT_ROLES.filter(
        (spec) => !allAccounts.some((acc) => acc.curve === spec.curve && acc.path === spec.path)
      );

      if (missingRoles.length === 0) {
        return wallets;
      }

      const accountsToCreate = missingRoles.map((spec) => ({
        curve: spec.curve,
        pathFormat: 'PATH_FORMAT_BIP32' as const,
        path: spec.path,
        addressFormat: spec.addressFormat,
      }));

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
        `Failed to ensure wallet with accounts: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }, onExpired);
}
