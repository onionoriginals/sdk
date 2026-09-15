/**
 * Canonical Turnkey wallet-account role table.
 *
 * Shared between the client and server Turnkey utilities so both sides of
 * the package agree on exactly which curve, derivation path, and address
 * format identifies each account this package provisions.
 */

import type { TurnkeyWallet, TurnkeyWalletAccount } from './types.js';

/**
 * Canonical roles for the Turnkey accounts this package provisions and
 * depends on. A role is identified by its exact curve, derivation path,
 * **and** address format:
 * - Curve alone cannot distinguish the two `CURVE_ED25519` accounts (DID
 *   assertion-key vs. update-key) — they're told apart by path.
 * - Curve + path alone cannot distinguish a repaired account from the stale
 *   account it replaces when both live at the *same* path: a sub-org
 *   provisioned before #748's fix has a `CURVE_SECP256K1` account at the
 *   Bitcoin auth-key path with an Ethereum address format, and repairing it
 *   in place (Turnkey wallet accounts are immutable) means adding a second
 *   account at that identical curve/path with the corrected address format
 *   alongside the stale one (#749) — only address format tells the two
 *   apart.
 */
export type TurnkeyAccountRole = 'bitcoin-auth' | 'did-assertion' | 'did-update';

export interface TurnkeyAccountRoleSpec {
  readonly role: TurnkeyAccountRole;
  readonly curve: 'CURVE_SECP256K1' | 'CURVE_ED25519';
  readonly path: string;
  readonly addressFormat: 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR' | 'ADDRESS_FORMAT_SOLANA';
}

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

/**
 * Frozen (entries included) so a caller can't mutate the table that every
 * lookup and repair path in this package relies on.
 */
export const TURNKEY_ACCOUNT_ROLES: readonly TurnkeyAccountRoleSpec[] = Object.freeze(
  TURNKEY_ACCOUNT_ROLE_SPECS.map((spec) => Object.freeze({ ...spec }))
);

/**
 * Get a wallet account by its canonical role: exact curve, derivation path,
 * **and** address format. Returns `null` rather than guessing when no
 * account matches all three — in particular, a stale account sharing a
 * role's curve and path but not its address format (see #749) does not
 * satisfy the role.
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
      if (
        account.curve === spec.curve &&
        account.path === spec.path &&
        account.addressFormat === spec.addressFormat
      ) {
        return account;
      }
    }
  }
  return null;
}
