/**
 * Regression tests for getScureNetwork in transfer.ts and transactions/commit.ts.
 *
 * Both functions previously had a `default: return btc.NETWORK` (mainnet)
 * fallback. Although the parameter is a union type, that branch is reachable at
 * runtime via type coercion / external data, silently assuming mainnet (real
 * funds). These tests assert that valid networks map correctly and that an
 * unknown network value THROWS instead of silently returning mainnet.
 */
import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { getScureNetwork as getScureNetworkTransfer } from '../../../src/bitcoin/transfer';
import { getScureNetwork as getScureNetworkCommit } from '../../../src/bitcoin/transactions/commit.js';

const REGTEST_BECH32 = 'bcrt';

describe('getScureNetwork (transfer.ts)', () => {
  test('maps known networks to the correct @scure network objects', () => {
    expect(getScureNetworkTransfer('mainnet')).toBe(btc.NETWORK);
    expect(getScureNetworkTransfer('signet')).toBe(btc.TEST_NETWORK);
    expect(getScureNetworkTransfer('testnet')).toBe(btc.TEST_NETWORK);
    expect(getScureNetworkTransfer('regtest').bech32).toBe(REGTEST_BECH32);
  });

  test('throws on an unknown network instead of defaulting to mainnet', () => {
    // Reaches the previously-silent default branch via type coercion.
    expect(() => getScureNetworkTransfer('bogus' as any)).toThrow(/Unsupported Bitcoin network/);
    expect(() => getScureNetworkTransfer(undefined as any)).toThrow(/Unsupported Bitcoin network/);
    expect(() => getScureNetworkTransfer('Mainnet' as any)).toThrow(/Unsupported Bitcoin network/);
  });
});

describe('getScureNetwork (transactions/commit.ts)', () => {
  test('maps known networks to the correct @scure network objects', () => {
    expect(getScureNetworkCommit('mainnet')).toBe(btc.NETWORK);
    expect(getScureNetworkCommit('signet')).toBe(btc.TEST_NETWORK);
    expect(getScureNetworkCommit('testnet')).toBe(btc.TEST_NETWORK);
    expect(getScureNetworkCommit('regtest').bech32).toBe(REGTEST_BECH32);
  });

  test('throws on an unknown network instead of defaulting to mainnet', () => {
    expect(() => getScureNetworkCommit('bogus' as any)).toThrow(/Unsupported Bitcoin network/);
    expect(() => getScureNetworkCommit(undefined as any)).toThrow(/Unsupported Bitcoin network/);
    expect(() => getScureNetworkCommit('Mainnet' as any)).toThrow(/Unsupported Bitcoin network/);
  });
});
