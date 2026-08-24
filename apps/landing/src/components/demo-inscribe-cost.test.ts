/**
 * The price a signed-out visitor sees.
 *
 * Before this note existed, nothing on the page quoted a number: the Protocol
 * table said "BTC fees / One-time network fees" and the deposit panel — the
 * only place a real figure appears — is behind sign-in. The note fills that
 * gap, so the one thing it must never do is drift from the quote the deposit
 * route would actually hand the same visitor once they sign in.
 *
 * These tests re-derive both figures from `estimateInscriptionCostSats`, the
 * server's own source of truth, rather than pinning the strings.
 */
import { describe, test, expect } from 'bun:test';
import { inscribeCostNote } from './Demo';
import { demo } from '../content';
import {
  estimateInscriptionCostSats,
  P2TR_OUTPUT_VB,
  P2WPKH_OUTPUT_VB,
  POSTAGE_SATS,
} from '../../server/bitcoin';

/**
 * Exactly what GET /api/btc/deposit prices: one input (a fresh deposit
 * address holds nothing yet), and the 8,000-byte content default it falls
 * back to because this client sends no `contentBytes` hint.
 */
const quote = (feeRate: number) =>
  estimateInscriptionCostSats({
    feeRate,
    inputs: 1,
    contentBytes: 8_000,
    commitOutputsVB: [P2TR_OUTPUT_VB, P2WPKH_OUTPUT_VB],
  });

describe('the inscribe-step cost note', () => {
  test('is shown to a visitor the deposit panel will never quote', () => {
    expect(inscribeCostNote(false)).toBe(demo.inscribeCost);
  });

  test('is withheld from a real visitor, who gets the live figure instead', () => {
    expect(inscribeCostNote(true)).toBeNull();
  });

  test('quotes the server’s own estimate at 1 sat/vB', () => {
    // 4,055 sats, said as "around 4,000". The bounds are what make that
    // rounding honest: a change to the buffer, the postage or the default
    // content size that moved the real quote out of this band would fail
    // here rather than leave the page quoting a stale number.
    const actual = quote(1);
    expect(actual).toBeGreaterThan(4_000);
    expect(actual).toBeLessThan(5_000);
    expect(demo.inscribeCost).toContain('4,000 sats at 1 sat/vB');
  });

  test('quotes the server’s own estimate at 5 sat/vB', () => {
    const actual = quote(5);
    expect(actual).toBeGreaterThan(18_000);
    expect(actual).toBeLessThan(19_000);
    expect(demo.inscribeCost).toContain('18,000 at 5 sat/vB');
  });

  test('names the postage the estimate actually includes', () => {
    expect(demo.inscribeCost).toContain(`${POSTAGE_SATS}-sat output`);
  });

  test('says the figure is live, because the fee rate it multiplies is', () => {
    // `currentFeeRate` reads provider.estimateFee on every quote. A note that
    // presented these numbers as fixed would be the dishonest version.
    expect(demo.inscribeCost).toMatch(/quoted live/i);
  });

  test('keeps the deposit copy’s two hard facts: one-time, and no refund', () => {
    expect(demo.inscribeCost).toMatch(/one-time/i);
    expect(demo.inscribeCost).toMatch(/refundable/i);
  });
});
