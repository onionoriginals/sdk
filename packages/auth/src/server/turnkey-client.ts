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
 * Normalize an email address for use as a stable identity key.
 *
 * Turnkey sub-org lookup filters on the exact email string, so
 * `Alice@x.com` and `alice@x.com` would otherwise resolve to different
 * sub-organizations and fork the user's identity.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Wallet/account layout required for DID creation. Shared between the
// sub-org creation path and the walletless-repair path so both produce
// identical wallets.
const DEFAULT_WALLET_NAME = 'default-wallet';
const DEFAULT_WALLET_ACCOUNTS = [
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
] as const;

/**
 * Whether an error from the Turnkey API definitively means the queried
 * resource does not exist (as opposed to a transient/network/auth failure).
 * gRPC status code 5 is NOT_FOUND. Walks the `cause` chain (cycle-safe) in
 * case the original Turnkey error arrives wrapped.
 */
function isDefinitiveNotFound(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (code === 5) {
      return true;
    }
    if (typeof message === 'string' && /not[ _-]?found|does not exist/i.test(message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Get or create a Turnkey sub-organization for a user.
 *
 * The sub-org ID is the user's **stable identity** (JWT `sub`, user-record
 * key, DID ownership), so this function must never mint a second sub-org for
 * an email that already has one:
 * - the email is normalized (trim + lowercase) before every Turnkey filter;
 * - a lookup failure only falls through to creation on a definitive
 *   not-found — transient/API errors are rethrown;
 * - an existing sub-org that lacks a wallet gets a wallet created **in
 *   place** rather than being replaced by a new sub-org;
 * - when multiple sub-orgs match the email (a pre-existing anomaly), the
 *   selection is deterministic so every login resolves the same identity.
 */
export async function getOrCreateTurnkeySubOrg(
  email: string,
  turnkeyClient: Turnkey
): Promise<string> {
  const organizationId = process.env.TURNKEY_ORGANIZATION_ID;
  if (!organizationId) {
    throw new Error('TURNKEY_ORGANIZATION_ID is required');
  }

  const normalizedEmail = normalizeEmail(email);

  let subOrgIds: string[] = [];
  try {
    const subOrgs = await turnkeyClient.apiClient().getSubOrgIds({
      organizationId,
      filterType: 'EMAIL',
      filterValue: normalizedEmail,
    });
    subOrgIds = subOrgs.organizationIds || [];
  } catch (error) {
    // Only a definitive not-found may fall through to creation. Treating a
    // transient failure (network blip, 429, auth misconfig) as "no existing
    // sub-org" would mint a duplicate identity for an existing user.
    if (!isDefinitiveNotFound(error)) {
      throw new Error(
        `Failed to look up existing Turnkey sub-organization: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  if (subOrgIds.length > 0) {
    if (subOrgIds.length > 1) {
      // Multiple sub-orgs for one email means identity already forked
      // (pre-fix data). Turnkey's getSubOrgIds exposes no creation
      // timestamps and no ordering guarantee, so sort for a selection that
      // is stable across logins and alert for manual reconciliation.
      console.warn(
        `[auth] Multiple Turnkey sub-organizations (${subOrgIds.length}) found for one email; ` +
          'selecting deterministically. These duplicate identities should be reconciled manually.'
      );
    }
    const existingSubOrgId = [...subOrgIds].sort()[0];

    // Ensure the sub-org has a wallet; repair in place if not.
    let walletCount: number;
    try {
      const walletsCheck = await turnkeyClient.apiClient().getWallets({
        organizationId: existingSubOrgId,
      });
      walletCount = walletsCheck.wallets?.length || 0;
    } catch (walletCheckErr) {
      console.error('[auth] Could not check wallets in existing sub-org:', walletCheckErr);
      return existingSubOrgId;
    }

    if (walletCount === 0) {
      // Repair the EXISTING identity: create the wallet under the existing
      // sub-org. Creating a new sub-org here would fork the user's identity
      // (and again on every subsequent login).
      console.warn('[auth] Existing sub-org has no wallet; creating wallet in place');
      await turnkeyClient.apiClient().createWallet({
        organizationId: existingSubOrgId,
        walletName: DEFAULT_WALLET_NAME,
        accounts: [...DEFAULT_WALLET_ACCOUNTS],
      });
    }

    return existingSubOrgId;
  }

  // Generate a unique name for the new sub-org
  const baseSubOrgName = `user-${normalizedEmail.replace(/[^a-z0-9]/gi, '-')}`;
  const subOrgName = `${baseSubOrgName}-${Date.now()}`;

  // Create sub-organization with wallet containing required keys
  const result = await turnkeyClient.apiClient().createSubOrganization({
    subOrganizationName: subOrgName,
    rootUsers: [
      {
        userName: normalizedEmail,
        userEmail: normalizedEmail,
        apiKeys: [],
        authenticators: [],
        oauthProviders: [],
      },
    ],
    rootQuorumThreshold: 1,
    wallet: {
      walletName: DEFAULT_WALLET_NAME,
      accounts: [...DEFAULT_WALLET_ACCOUNTS],
    },
  });

  const subOrgId = result.activity?.result?.createSubOrganizationResultV7?.subOrganizationId;

  if (!subOrgId) {
    throw new Error('No sub-organization ID returned from Turnkey');
  }

  return subOrgId;
}
