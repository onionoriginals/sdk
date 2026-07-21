import { describe, test, expect } from 'bun:test';
import {
  otpLoginToSession,
  ensureBitcoinFundingAccount,
  type TurnkeyBitcoinClient,
  type TurnkeySessionApi,
} from './turnkey-session';

describe('turnkey-session helpers', () => {
  test('otpLoginToSession calls otpLogin with a client signature and returns the session', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const turnkey: TurnkeySessionApi = {
      async otpLogin(params) {
        calls.push(params);
        return { session: 'session-jwt-xyz' };
      },
    };
    const { session } = await otpLoginToSession({
      turnkey,
      subOrgId: 'sub-1',
      verificationToken: 'vtoken',
      // A valid P-256 keypair: private key = 32 bytes of 0x02, any 33-byte pub hex.
      p256PublicKey: '02'.padEnd(66, 'a'),
      p256PrivateKey: '02'.repeat(32),
    });
    expect(session).toBe('session-jwt-xyz');
    expect(calls[0].organizationId).toBe('sub-1');
    expect(calls[0].verificationToken).toBe('vtoken');
    expect(typeof calls[0].clientSignature).toBe('string');
    expect((calls[0].clientSignature as string).length).toBeGreaterThan(0);
  });

  test('ensureBitcoinFundingAccount adds a testnet P2WPKH account and returns its tb1 address (idempotent)', async () => {
    let existing: Array<{ address: string; path: string }> = [];
    const client: TurnkeyBitcoinClient = {
      async getWallets() {
        return { wallets: [{ walletId: 'w1', accounts: existing }] };
      },
      async createWalletAccounts(params) {
        const address = 'tb1qexampleuseraddr000000000000000000000000';
        existing = [{ address, path: params.accounts[0].path }];
        return { addresses: [address] };
      },
      async signTransaction() {
        throw new Error('not used here');
      },
    };
    const addr = await ensureBitcoinFundingAccount(client, 'sub-1');
    expect(addr.startsWith('tb1q')).toBe(true);
    // Second call must NOT create a duplicate account — returns the cached one.
    const addr2 = await ensureBitcoinFundingAccount(client, 'sub-1');
    expect(addr2).toBe(addr);
  });
});
