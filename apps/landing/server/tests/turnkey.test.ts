import { describe, test, expect } from 'bun:test';
import { getEd25519Account, type TurnkeyLike } from '../turnkey';

function mockTurnkey(): TurnkeyLike {
  return {
    apiClient: () => ({
      getWallets: async () => ({ wallets: [{ walletId: 'w1' }] }),
      getWalletAccounts: async () => ({
        accounts: [
          { curve: 'CURVE_SECP256K1', address: '0xeth', organizationId: 'sub1' },
          { curve: 'CURVE_ED25519', address: 'SoLAnaAddr', organizationId: 'sub1' },
        ],
      }),
    }),
  } as unknown as TurnkeyLike;
}

describe('getEd25519Account', () => {
  test('selects the ed25519 account and builds did:key', async () => {
    const res = await getEd25519Account(mockTurnkey(), 'sub1');
    expect(res.address).toBe('SoLAnaAddr');
    expect(res.verificationMethodId).toBe('did:key:SoLAnaAddr');
    expect(res.signingOrganizationId).toBe('sub1');
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
