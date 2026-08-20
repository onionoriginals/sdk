import { describe, test, expect } from 'bun:test';
import { demo } from '../content';
import { depositErrorMessage } from './Demo';

/**
 * U5 — the old `inscribeGate` block mixed testnet4 copy with strings the
 * mainnet path renders, which is how "inscribe on Bitcoin testnet4" ended up
 * one flag away from a mainnet screen. It is now `demo.testnet4`, reachable
 * only on a testnet4 build, and the explorer label moved to `demo.done.real`
 * where the tier that may show a link owns it.
 */
describe('testnet4-only copy', () => {
  test('the block exists and names its network in the strings that need it', () => {
    for (const key of ['signInPrompt', 'stepDescription', 'yourKeyNote', 'faucetEmpty', 'fundingFailed'] as const) {
      expect(typeof demo.testnet4[key]).toBe('string');
      expect(demo.testnet4[key].length).toBeGreaterThan(0);
    }
    expect(demo.testnet4.signInPrompt).toContain('testnet4');
    expect(demo.testnet4.yourKeyNote).toContain('faucet');
  });

  test('the explorer label belongs to the real completion state', () => {
    expect(typeof demo.done.real.explorerLabel).toBe('string');
    expect(demo.done.real.explorerLabel).toContain('mempool.space');
    expect('explorerLabel' in demo.done.simulated).toBe(false);
  });
});

/**
 * R3 / KTD3 — when the one fee source is down the deposit route quotes
 * nothing. The creator must be told THAT, in copy, and must not be left with
 * a stale number or a "checking…" that silently never resolves.
 */
describe('deposit fee-source-unavailable copy', () => {
  test('content.ts carries the estimator-unavailable message', () => {
    expect(typeof demo.deposit.feeUnavailable).toBe('string');
    expect(demo.deposit.feeUnavailable.length).toBeGreaterThan(0);
    expect(typeof demo.deposit.unavailableBadge).toBe('string');
    expect(demo.deposit.unavailableBadge.length).toBeGreaterThan(0);
  });

  test('the named server error maps onto that copy, and unnamed failures get their own', () => {
    expect(depositErrorMessage({ error: 'fee_estimate_unavailable' })).toBe(demo.deposit.feeUnavailable);
    // U4/R28: a failed UTXO read is its OWN disclosed state, not the fee one.
    // It used to map to null — a "transient blip" that left the last quote on
    // screen as though it were current. See deposit-indexer-copy.test.ts.
    expect(depositErrorMessage({ error: 'utxo_lookup_failed' })).not.toBe(demo.deposit.feeUnavailable);
    // C1/F3: an unnamed failure is no longer null either. Null was what the
    // caller keyed its stale-quote purge on, so the codes nobody had thought
    // to name kept the last address and quote on screen. See
    // deposit-error-table.test.ts for the whole default arm.
    expect(depositErrorMessage(null)).toBe(demo.deposit.unknownError);
    expect(depositErrorMessage({})).toBe(demo.deposit.unknownError);
    expect(depositErrorMessage({})).not.toBe(demo.deposit.feeUnavailable);
  });
});
