import { describe, expect, mock, test } from 'bun:test';
import type { Turnkey } from '@turnkey/sdk-server';
import {
  createWalletWithAccounts,
  TurnkeySessionExpiredError,
} from '../src/client/turnkey-client.js';

const wallet = { walletId: 'wallet_visibility_858', walletName: 'default-wallet' };
const account = {
  address: 'test-address',
  curve: 'CURVE_ED25519' as const,
  path: "m/44'/501'/0'/0'",
  addressFormat: 'ADDRESS_FORMAT_SOLANA',
};

// Instance-local mocks and real timers: no module or global mocks to leak.
function fixture(visibleOnRead = 1) {
  let reads = 0;
  const api = {
    createWallet: mock(async () => ({ walletId: wallet.walletId })),
    getWallets: mock(async () => ({
      wallets: ++reads >= visibleOnRead ? [wallet] : [],
    })),
    getWalletAccounts: mock(async () => ({ accounts: [account] })),
  };
  const client = { apiClient: () => api } as unknown as Turnkey;
  return { api, client };
}

describe('created wallet visibility (#858)', () => {
  for (const visibleOnRead of [1, 2, 3]) {
    test(`returns the created wallet when visible on read ${visibleOnRead}`, async () => {
      const { api, client } = fixture(visibleOnRead);
      const result = await createWalletWithAccounts(client, 'sub-org');
      expect(result).toEqual({ ...wallet, accounts: [account] });
      expect(api.createWallet).toHaveBeenCalledTimes(1);
      expect(api.getWallets).toHaveBeenCalledTimes(visibleOnRead);
      expect(api.getWallets).toHaveBeenLastCalledWith({ organizationId: 'sub-org' });
      expect(api.getWalletAccounts).toHaveBeenCalledTimes(1);
    });
  }

  test('bounds missing-wallet reads and reports successful creation with its ID', async () => {
    const { api, client } = fixture(Infinity);
    // A different wallet must not be mistaken for the newly created one.
    api.getWallets.mockImplementation(async () => ({
      wallets: [{ walletId: 'unrelated-wallet', walletName: 'other' }],
    }));
    const error = await createWalletWithAccounts(client, 'sub-org').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(wallet.walletId);
    expect((error as Error).message).toContain('created successfully');
    expect((error as Error).message).toContain('3 attempts');
    expect((error as Error).message).not.toContain('Failed to create wallet');
    expect(api.getWallets).toHaveBeenCalledTimes(3);
    expect(api.createWallet).toHaveBeenCalledTimes(1);
  });

  for (const stage of ['createWallet', 'getWallets', 'getWalletAccounts'] as const) {
    for (const expired of [false, true]) {
      test(`${stage} ${expired ? 'session expiry' : 'backend failure'} stops without retry`, async () => {
        const { api, client } = fixture();
        const failure = Object.assign(new Error(expired ? 'unauthenticated' : 'backend unavailable'), {
          code: expired ? 16 : 13,
        });
        api[stage].mockImplementation(async () => {
          throw failure;
        });
        const onExpired = mock(() => {});
        const error = await createWalletWithAccounts(client, 'sub-org', onExpired)
          .catch((error: unknown) => error);
        if (expired) {
          expect(error).toBeInstanceOf(TurnkeySessionExpiredError);
          expect(onExpired).toHaveBeenCalledTimes(1);
        } else {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).cause).toBe(failure);
          expect(onExpired).not.toHaveBeenCalled();
          if (stage !== 'createWallet') {
            expect((error as Error).message).not.toContain('Failed to create wallet');
          }
        }
        expect(api.createWallet).toHaveBeenCalledTimes(1);
        expect(api.getWallets).toHaveBeenCalledTimes(stage === 'createWallet' ? 0 : 1);
        expect(api.getWalletAccounts).toHaveBeenCalledTimes(stage === 'getWalletAccounts' ? 1 : 0);
      });
    }
  }

  for (const expired of [false, true]) {
    test(`stops on ${expired ? 'expiry' : 'backend error'} after an earlier visibility miss`, async () => {
      const { api, client } = fixture();
      const failure = Object.assign(new Error('read failed'), { code: expired ? 16 : 13 });
      api.getWallets.mockResolvedValueOnce({ wallets: [] });
      api.getWallets.mockRejectedValueOnce(failure);
      const onExpired = mock(() => {});
      const error = await createWalletWithAccounts(client, 'sub-org', onExpired)
        .catch((error: unknown) => error);
      if (expired) {
        expect(error).toBeInstanceOf(TurnkeySessionExpiredError);
        expect(onExpired).toHaveBeenCalledTimes(1);
      } else {
        expect((error as Error).cause).toBe(failure);
        expect(onExpired).not.toHaveBeenCalled();
      }
      expect(api.getWallets).toHaveBeenCalledTimes(2);
      expect(api.createWallet).toHaveBeenCalledTimes(1);
      expect(api.getWalletAccounts).not.toHaveBeenCalled();
    });
  }
});
