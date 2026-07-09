import { createTurnkeyClient } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';

let cached: Turnkey | null = null;

export function getTurnkey(): Turnkey {
  if (!cached) cached = createTurnkeyClient(); // reads TURNKEY_* env; throws if missing
  return cached;
}

// Minimal structural type so getEd25519Account is testable with a mock.
export type TurnkeyLike = {
  apiClient: () => {
    getWallets: (a: { organizationId: string }) => Promise<{ wallets?: { walletId: string }[] }>;
    getWalletAccounts: (a: { organizationId: string; walletId: string }) => Promise<{
      accounts?: { curve: string; address: string; organizationId?: string }[];
    }>;
  };
};

// Ported from boop convex/turnkeyHelpers.ts. The PARENT Turnkey API key can
// read wallets/accounts and sign for a sub-org (proven in production).
export async function getEd25519Account(turnkey: TurnkeyLike, subOrgId: string) {
  const walletsResponse = await turnkey.apiClient().getWallets({ organizationId: subOrgId });
  const wallets = walletsResponse.wallets;
  if (!wallets || wallets.length === 0) throw new Error('No wallets found for sub-org');

  const accountsResponse = await turnkey
    .apiClient()
    .getWalletAccounts({ organizationId: subOrgId, walletId: wallets[0].walletId });
  const accounts = accountsResponse.accounts;
  if (!accounts || accounts.length === 0) throw new Error('No wallet accounts found for sub-org');

  const ed = accounts.find((a) => a.curve === 'CURVE_ED25519');
  if (!ed) throw new Error('No Ed25519 account found in wallet');

  const signingOrganizationId = ed.organizationId || subOrgId;
  return {
    address: ed.address,
    verificationMethodId: `did:key:${ed.address}`,
    signingOrganizationId,
  };
}
