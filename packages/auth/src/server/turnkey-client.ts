/**
 * Server-side Turnkey client utilities
 */

import { Turnkey } from '@turnkey/sdk-server';
import { StructuredError } from '@originals/sdk';
import { normalizeEmail } from '../email.js';
import { TURNKEY_ACCOUNT_ROLES } from '../turnkey-roles.js';

export { normalizeEmail };

/**
 * Stable error codes for server-side Turnkey client/sub-org failures (#747).
 */
export const AUTH_TURNKEY_ERROR_CODES = {
  configApiPublicKeyMissing: 'AUTH_TURNKEY_CONFIG_API_PUBLIC_KEY_MISSING',
  configApiPrivateKeyMissing: 'AUTH_TURNKEY_CONFIG_API_PRIVATE_KEY_MISSING',
  configOrganizationIdMissing: 'AUTH_TURNKEY_CONFIG_ORGANIZATION_ID_MISSING',
  subOrgLookupFailed: 'AUTH_TURNKEY_SUBORG_LOOKUP_FAILED',
  subOrgCreateFailed: 'AUTH_TURNKEY_SUBORG_CREATE_FAILED',
} as const;

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
    throw new StructuredError(
      AUTH_TURNKEY_ERROR_CODES.configApiPublicKeyMissing,
      'TURNKEY_API_PUBLIC_KEY is required'
    );
  }
  if (!apiPrivateKey) {
    throw new StructuredError(
      AUTH_TURNKEY_ERROR_CODES.configApiPrivateKeyMissing,
      'TURNKEY_API_PRIVATE_KEY is required'
    );
  }
  if (!organizationId) {
    throw new StructuredError(
      AUTH_TURNKEY_ERROR_CODES.configOrganizationIdMissing,
      'TURNKEY_ORGANIZATION_ID is required'
    );
  }

  return new Turnkey({
    apiBaseUrl: config?.apiBaseUrl ?? 'https://api.turnkey.com',
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: organizationId,
  });
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
    addressFormat: 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR',
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
 * A mutual-exclusion lock keyed by string, used to serialize the
 * lookup-then-create sequence in {@link getOrCreateTurnkeySubOrg} per
 * normalized email.
 */
export interface SubOrgLock {
  /**
   * Run `fn` with exclusive access for `key`. Calls for the same `key` must
   * be serialized (queued, not rejected); calls for different keys must NOT
   * block one another. Must release the lock once `fn` settles, whether it
   * resolves or rejects.
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Create an in-process, per-key single-flight lock.
 *
 * **Production warning**: like {@link createInMemorySessionStorage}, this
 * lock only serializes calls within a single process. `@originals/auth`
 * supports shared/multi-instance deployments, and this lock provides no
 * protection against two different instances handling concurrent requests
 * for the same brand-new email at the same time. For multi-instance
 * deployments, inject a distributed {@link SubOrgLock} (e.g. backed by a
 * Redis `SET NX` mutex or another cross-process reservation primitive).
 */
export function createInProcessSubOrgLock(): SubOrgLock {
  const queues = new Map<string, Promise<void>>();

  return {
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = queues.get(key) ?? Promise.resolve();
      const run = previous.then(fn, fn);
      // A tail promise that always settles, so later callers for this key
      // queue up regardless of whether this call's `fn` threw.
      const settled = run.then(
        () => undefined,
        () => undefined
      );
      queues.set(key, settled);
      // Once this is the last queued call for `key`, drop the entry so the
      // map doesn't grow unbounded for a long-lived process handling many
      // distinct emails.
      void settled.then(() => {
        if (queues.get(key) === settled) {
          queues.delete(key);
        }
      });
      return run;
    },
  };
}

// Default lock used when getOrCreateTurnkeySubOrg is called without one.
let defaultSubOrgLock: SubOrgLock | null = null;

function getDefaultSubOrgLock(): SubOrgLock {
  if (!defaultSubOrgLock) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[auth] Using an in-process lock to serialize Turnkey sub-organization ' +
          'creation: this does not protect against concurrent requests handled ' +
          'by different instances. Pass a distributed SubOrgLock for multi-instance deployments.'
      );
    }
    defaultSubOrgLock = createInProcessSubOrgLock();
  }
  return defaultSubOrgLock;
}

/**
 * Walks the `cause` chain (cycle-safe) and returns the first numeric `code`
 * found, or `undefined` if none is present anywhere in the chain.
 *
 * `@turnkey/http`'s `TurnkeyRequestError` always carries a numeric gRPC
 * status `code` parsed from Turnkey's own JSON error body — for ANY error
 * Turnkey's API returned a response for, not only a rejected OTP: auth
 * failures, rate-limiting, and internal errors are also structured
 * `TurnkeyRequestError`s with their own (different) codes. A
 * transport/routing failure (network blip, timeout, DNS, a proxy error
 * page, `ECONNRESET`) throws a plain `Error` with no `code` at all, because
 * the request never reached a point where Turnkey could respond.
 *
 * Callers needing "Turnkey definitively rejected THIS SPECIFIC condition"
 * (e.g. {@link isDefinitiveNotFound}, or `email-auth.ts`'s OTP-verification
 * catch) must compare the returned code against the exact expected value —
 * never merely check it is present — or an unrelated Turnkey-side failure
 * (rate limit, permission, internal error) gets misclassified as that
 * specific condition (#747/#819).
 */
export function extractTurnkeyErrorCode(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code } = current as { code?: unknown };
    if (typeof code === 'number') {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * gRPC status code 3, INVALID_ARGUMENT — the code Turnkey's `verifyOtp`
 * returns when it definitively rejects a submitted OTP code (confirmed by
 * #819's own repro: `"Turnkey error 3: invalid OTP code"`). Used by
 * `email-auth.ts` to distinguish a genuinely wrong code from every other
 * Turnkey-side failure (auth, rate-limiting, internal errors), which must
 * NOT be charged against the local brute-force attempt budget.
 */
export const TURNKEY_GRPC_INVALID_ARGUMENT = 3;

/**
 * Whether an error from the Turnkey API definitively means the queried
 * resource does not exist (as opposed to a transient/network/auth failure).
 * gRPC status code 5 is NOT_FOUND.
 *
 * Only the strongly-typed `code === 5` evidence is trusted — never merely
 * "some numeric code is present", since other Turnkey-side failures (auth,
 * rate-limiting) also carry a code. A message-substring match on "not
 * found"/"does not exist" would accept an unrelated transport error as if
 * it were Turnkey's own not-found response, and this function must never do
 * that: fall through to `createSubOrganization` on such an ambiguous error
 * mints a duplicate identity for an existing user.
 */
function isDefinitiveNotFound(error: unknown): boolean {
  return extractTurnkeyErrorCode(error) === 5;
}

const BITCOIN_AUTH_ROLE = TURNKEY_ACCOUNT_ROLES.find((spec) => spec.role === 'bitcoin-auth')!;

/**
 * Repair a stale Bitcoin auth-key account left over from before #748's fix:
 * a sub-org created before that fix has a wallet whose `CURVE_SECP256K1`
 * `m/44'/0'/0'/0/0` account carries an Ethereum address format instead of
 * the Bitcoin one the account is documented and consumed as. Turnkey wallet
 * accounts are immutable once created, so the repair adds a **second**
 * account at that same curve/path with the corrected address format,
 * alongside the stale one, rather than mutating anything in place — and
 * never mints a replacement sub-org.
 *
 * Fails soft (logs and returns) when detection itself fails, matching the
 * existing wallet-count check: a transient read failure must not block
 * login. An actual repair-write failure (`createWalletAccounts`) propagates,
 * matching the walletless-repair path's behavior.
 */
async function repairStaleBitcoinAuthKey(
  turnkeyClient: Turnkey,
  organizationId: string,
  walletId: string
): Promise<void> {
  let accounts: Array<{ curve: string; path: string; addressFormat: string }>;
  try {
    const response = await turnkeyClient.apiClient().getWalletAccounts({
      organizationId,
      walletId,
    });
    accounts = response.accounts || [];
  } catch (error) {
    console.error(
      '[auth] Could not check wallet accounts for a stale Bitcoin auth-key:',
      error
    );
    return;
  }

  const hasCorrectAccount = accounts.some(
    (acc) =>
      acc.curve === BITCOIN_AUTH_ROLE.curve &&
      acc.path === BITCOIN_AUTH_ROLE.path &&
      acc.addressFormat === BITCOIN_AUTH_ROLE.addressFormat
  );
  if (hasCorrectAccount) {
    return;
  }

  const hasStaleAccount = accounts.some(
    (acc) => acc.curve === BITCOIN_AUTH_ROLE.curve && acc.path === BITCOIN_AUTH_ROLE.path
  );
  if (!hasStaleAccount) {
    // No account at all at the Bitcoin auth-key path - an unexpected wallet
    // layout outside this repair's scope. Leave it alone rather than guess.
    return;
  }

  console.warn(
    `[auth] Repairing stale Ethereum-formatted Bitcoin auth-key account in wallet ${walletId}`
  );
  await turnkeyClient.apiClient().createWalletAccounts({
    organizationId,
    walletId,
    accounts: [
      {
        curve: BITCOIN_AUTH_ROLE.curve,
        pathFormat: 'PATH_FORMAT_BIP32',
        path: BITCOIN_AUTH_ROLE.path,
        addressFormat: BITCOIN_AUTH_ROLE.addressFormat,
      },
    ],
  });
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
 * - a failure checking whether that wallet exists is rethrown, never
 *   swallowed into a false "wallet present" success (#805) — unlike the
 *   sub-org lookup, this check has no legitimate not-found case to
 *   distinguish, since a genuinely walletless sub-org is a successful empty
 *   `{ wallets: [] }` response;
 * - an existing sub-org whose wallet still carries a stale, pre-#748
 *   Ethereum-formatted Bitcoin auth-key account gets the corrected account
 *   added **in place** (see {@link repairStaleBitcoinAuthKey}), again rather
 *   than being replaced;
 * - when multiple sub-orgs match the email (a pre-existing anomaly), the
 *   selection is deterministic so every login resolves the same identity;
 * - the lookup-then-create sequence is serialized per normalized email via
 *   `lock` (see {@link SubOrgLock}), so two concurrent calls for the same
 *   brand-new email cannot both observe "no existing sub-org" and both
 *   create one.
 *
 * @param lock - Serializes the lookup-then-create sequence per normalized
 *   email. Defaults to an in-process lock (see
 *   {@link createInProcessSubOrgLock}), which is sufficient for a single
 *   process but NOT across multiple server instances — pass a distributed
 *   {@link SubOrgLock} in multi-instance deployments.
 */
export async function getOrCreateTurnkeySubOrg(
  email: string,
  turnkeyClient: Turnkey,
  lock: SubOrgLock = getDefaultSubOrgLock()
): Promise<string> {
  const organizationId = process.env.TURNKEY_ORGANIZATION_ID;
  if (!organizationId) {
    throw new StructuredError(
      AUTH_TURNKEY_ERROR_CODES.configOrganizationIdMissing,
      'TURNKEY_ORGANIZATION_ID is required'
    );
  }

  const normalizedEmail = normalizeEmail(email);

  return lock.withLock(normalizedEmail, () =>
    getOrCreateTurnkeySubOrgUnlocked(normalizedEmail, organizationId, turnkeyClient)
  );
}

async function getOrCreateTurnkeySubOrgUnlocked(
  normalizedEmail: string,
  organizationId: string,
  turnkeyClient: Turnkey
): Promise<string> {
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
      throw new StructuredError(
        AUTH_TURNKEY_ERROR_CODES.subOrgLookupFailed,
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

    // Ensure the sub-org has a wallet; repair in place if not. Unlike the
    // sub-org lookup above, `getWallets` has no legitimate "not found" case
    // to distinguish: a sub-org with no wallet is a normal, successful
    // `{ wallets: [] }` response (#805). So any thrown error here - network
    // blip, timeout, rate limit - must propagate rather than be treated as
    // "a wallet exists, nothing to repair": swallowing it would report OTP
    // auth as successful without ever having established that the wallet
    // exists or is complete.
    let wallets: Array<{ walletId?: string }>;
    try {
      const walletsCheck = await turnkeyClient.apiClient().getWallets({
        organizationId: existingSubOrgId,
      });
      wallets = walletsCheck.wallets || [];
    } catch (walletCheckErr) {
      throw new Error(
        `Failed to check wallets in existing Turnkey sub-organization: ${
          walletCheckErr instanceof Error ? walletCheckErr.message : String(walletCheckErr)
        }`,
        { cause: walletCheckErr }
      );
    }

    if (wallets.length === 0) {
      // Repair the EXISTING identity: create the wallet under the existing
      // sub-org. Creating a new sub-org here would fork the user's identity
      // (and again on every subsequent login).
      console.warn('[auth] Existing sub-org has no wallet; creating wallet in place');
      await turnkeyClient.apiClient().createWallet({
        organizationId: existingSubOrgId,
        walletName: DEFAULT_WALLET_NAME,
        accounts: [...DEFAULT_WALLET_ACCOUNTS],
      });
      return existingSubOrgId;
    }

    // The sub-org already has at least one wallet: any of them may still
    // carry a stale, pre-#748 Ethereum-formatted Bitcoin auth-key account
    // (#749). This package itself only ever provisions one wallet per
    // sub-org, but a sub-org is not guaranteed to stay that way (manual
    // Turnkey console action, other tooling), so check every wallet rather
    // than assuming the stale account - if present - lives in the first one.
    // Repair each in place rather than minting a replacement sub-org.
    for (const wallet of wallets) {
      if (wallet.walletId) {
        await repairStaleBitcoinAuthKey(turnkeyClient, existingSubOrgId, wallet.walletId);
      }
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
    throw new StructuredError(
      AUTH_TURNKEY_ERROR_CODES.subOrgCreateFailed,
      'No sub-organization ID returned from Turnkey'
    );
  }

  return subOrgId;
}
