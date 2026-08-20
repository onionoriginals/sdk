import { describe, test, expect } from 'bun:test';
import { demo } from '../content';
import { depositErrorMessage } from './Demo';

describe('demo inscribe-gate copy', () => {
  test('has an inscribeGate copy block', () => {
    expect(demo.inscribeGate).toBeDefined();
    expect(typeof demo.inscribeGate.signInPrompt).toBe('string');
    expect(demo.inscribeGate.signInPrompt.length).toBeGreaterThan(0);
    expect(typeof demo.inscribeGate.yourKeyNote).toBe('string');
    expect(typeof demo.inscribeGate.explorerLabel).toBe('string');
    expect(typeof demo.inscribeGate.faucetEmpty).toBe('string');
    expect(typeof demo.inscribeGate.mockNote).toBe('string');
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

  test('the named server error maps onto that copy, and unnamed failures do not', () => {
    expect(depositErrorMessage({ error: 'fee_estimate_unavailable' })).toBe(demo.deposit.feeUnavailable);
    // U4/R28: a failed UTXO read is its OWN disclosed state, not the fee one.
    // It used to map to null — a "transient blip" that left the last quote on
    // screen as though it were current. See deposit-indexer-copy.test.ts.
    expect(depositErrorMessage({ error: 'utxo_lookup_failed' })).not.toBe(demo.deposit.feeUnavailable);
    expect(depositErrorMessage({ error: 'utxo_lookup_failed' })).not.toBeNull();
    expect(depositErrorMessage(null)).toBeNull();
    expect(depositErrorMessage({})).toBeNull();
  });
});
