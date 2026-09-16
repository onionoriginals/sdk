/**
 * Server-side Turnkey client utilities
 */

import { Turnkey } from '@turnkey/sdk-server';
import { normalizeEmail } from '../email.js';

export { normalizeEmail };

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
 * Whether an error from the Turnkey API definitively means the queried
 * resource does not exist (as opposed to a transient/network/auth failure).
 * gRPC status code 5 is NOT_FOUND. Walks the `cause` chain (cycle-safe) in
 * case the original Turnkey error arrives wrapped.
 *
 * Only the strongly-typed `code === 5` evidence is trusted. `@turnkey/http`'s
 * `TurnkeyRequestError` always carries a numeric `code` parsed from Turnkey's
 * own JSON error body, so a genuine Turnkey not-found response is never
 * missing it; a transport/routing failure (a plain-text 404 from an
 * unrelated host, a proxy error page) throws a plain `Error` with no `code`
 * at all. A message-substring match on "not found"/"does not exist" would
 * therefore accept that unrelated transport error as if it were Turnkey's
 * own not-found response, and this function must never do that: fall
 * through to `createSubOrganization` on such an ambiguous error mints a
 * duplicate identity for an existing user.
 */
function isDefinitiveNotFound(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code } = current as { code?: unknown };
    if (code === 5) {
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
 * - an existing sub-org whose wallet(s) are missing one or more required
 *   account roles (bitcoin-auth, did-assertion, did-update) gets the
 *   missing role(s) added **in place**, on one deterministic wallet, rather
 *   than being silently left incomplete;
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
    throw new Error('TURNKEY_ORGANIZATION_ID is required');
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
    let wallets: Array<{ walletId?: string }>;
    try {
      const walletsCheck = await turnkeyClient.apiClient().getWallets({
        organizationId: existingSubOrgId,
      });
      wallets = walletsCheck.wallets || [];
    } catch (walletCheckErr) {
      console.error('[auth] Could not check wallets in existing sub-org:', walletCheckErr);
      return existingSubOrgId;
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

    // The sub-org has at least one wallet, but wallet existence alone does
    // not mean every required account role (bitcoin-auth, did-assertion,
    // did-update) is present in it — only the walletless-repair path above
    // was ever checked. Enumerate accounts across ALL of the sub-org's
    // wallets (a role may be satisfied in any of them, not just the first)
    // and repair whichever roles are missing sub-org-wide.
    //
    // A failure enumerating any wallet's accounts means the true inventory
    // is unknown, so this fails soft and skips repair for this login rather
    // than risk inferring a role absent from incomplete data and creating a
    // duplicate account for a role that already exists in an unread wallet.
    const allAccounts: Array<{ curve: string; path: string }> = [];
    for (const wallet of wallets) {
      if (!wallet.walletId) {
        continue;
      }
      try {
        const accountsResponse = await turnkeyClient.apiClient().getWalletAccounts({
          organizationId: existingSubOrgId,
          walletId: wallet.walletId,
        });
        allAccounts.push(...(accountsResponse.accounts || []));
      } catch (accountsCheckErr) {
        console.error(
          '[auth] Could not check wallet accounts in existing sub-org:',
          accountsCheckErr
        );
        return existingSubOrgId;
      }
    }

    const missingAccounts = DEFAULT_WALLET_ACCOUNTS.filter(
      (spec) => !allAccounts.some((acc) => acc.curve === spec.curve && acc.path === spec.path)
    );

    const targetWalletId = wallets[0]?.walletId;
    if (missingAccounts.length > 0 && targetWalletId) {
      // Create every globally-missing role exactly once, on one
      // deterministic target wallet (the stable first wallet), rather than
      // adding it to every wallet that happens to lack it - that would
      // duplicate a role that is genuinely present elsewhere in the sub-org.
      console.warn(
        `[auth] Existing sub-org's wallet is missing ${missingAccounts.length} required ` +
          'account(s); repairing in place'
      );
      try {
        await turnkeyClient.apiClient().createWalletAccounts({
          organizationId: existingSubOrgId,
          walletId: targetWalletId,
          accounts: missingAccounts.map((spec) => ({ ...spec })),
        });
      } catch (repairWriteErr) {
        // This read-then-create sequence is only serialized within this
        // process (see the SubOrgLock production warning above); a
        // concurrent login handled by another instance can run the same
        // repair for the same missing role at the same time, and lose the
        // resulting write race with an error from Turnkey (e.g. a
        // duplicate-account rejection). Before treating that as a real
        // failure, re-check whether the role is now present - if a
        // concurrent repair already added it, the desired end state holds
        // and this login must not fail on a race it merely lost.
        let stillMissing = missingAccounts;
        try {
          const recheck = await turnkeyClient.apiClient().getWalletAccounts({
            organizationId: existingSubOrgId,
            walletId: targetWalletId,
          });
          const recheckAccounts = recheck.accounts || [];
          stillMissing = missingAccounts.filter(
            (spec) =>
              !recheckAccounts.some((acc) => acc.curve === spec.curve && acc.path === spec.path)
          );
        } catch {
          // The re-check itself failed - fall through and propagate the
          // original write error rather than guess at the true state.
        }
        if (stillMissing.length > 0) {
          throw repairWriteErr;
        }
        console.warn(
          '[auth] Repair write raced with a concurrent repair that already added the ' +
            'missing account(s); continuing'
        );
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
    throw new Error('No sub-organization ID returned from Turnkey');
  }

  return subOrgId;
}
