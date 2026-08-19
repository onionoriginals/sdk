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

  test('the named server error maps onto that copy, and nothing else does', () => {
    expect(depositErrorMessage({ error: 'fee_estimate_unavailable' })).toBe(demo.deposit.feeUnavailable);
    // A UTXO-lookup blip is a transient poll failure, not a "we cannot price
    // this" state — it keeps the existing waiting copy.
    expect(depositErrorMessage({ error: 'utxo_lookup_failed' })).toBeNull();
    expect(depositErrorMessage(null)).toBeNull();
    expect(depositErrorMessage({})).toBeNull();
  });
});
