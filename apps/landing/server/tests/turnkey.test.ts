import { describe, test, expect } from 'bun:test';
import { encoding } from '@originals/sdk';
import { getEd25519Account, type TurnkeyLike } from '../turnkey';

// A real base58btc-encoded 32-byte key (Solana address format, no multibase prefix).
const raw = new Uint8Array(32).fill(3);
const solAddr = encoding.multibase.encode(raw, 'base58btc').slice(1);

function mockTurnkey(): TurnkeyLike {
  return {
    apiClient: () => ({
      getWallets: async () => ({ wallets: [{ walletId: 'w1' }] }),
      getWalletAccounts: async () => ({
        accounts: [
          { curve: 'CURVE_SECP256K1', address: '0xeth', organizationId: 'acct-org' },
          // organizationId distinct from the passed subOrgId so signingOrganizationId selection is exercised.
          { curve: 'CURVE_ED25519', address: solAddr, organizationId: 'acct-org' },
        ],
      }),
    }),
  } as unknown as TurnkeyLike;
}

describe('getEd25519Account', () => {
  test('selects the ed25519 account and derives a Multikey did:key', async () => {
    const res = await getEd25519Account(mockTurnkey(), 'sub1');
    expect(res.address).toBe(solAddr);
    expect(res.publicKeyMultibase.startsWith('z')).toBe(true);
    expect(res.verificationMethodId.startsWith('did:key:z')).toBe(true);
    expect(res.signingOrganizationId).toBe('acct-org');
  });

  test('throws when no ed25519 account', async () => {
    const tk = {
      apiClient: () => ({
        getWallets: async () => ({ wallets: [{ walletId: 'w1' }] }),
        getWalletAccounts: async () => ({ accounts: [{ curve: 'CURVE_SECP256K1', address: '0x' }] }),
      }),
    } as unknown as TurnkeyLike;
    await expect(getEd25519Account(tk, 'sub1')).rejects.toThrow('No Ed25519 account');
  });
});
