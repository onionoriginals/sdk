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

/** The sats figure the copy states for a given rate, as a number. */
function quoted(rate: number): number {
  const m = demo.inscribeCost.match(new RegExp(`([\\d,]+)(?: sats)? at ${rate} sat/vB`));
  if (!m) throw new Error(`the copy states no figure for ${rate} sat/vB`);
  return Number(m[1].replace(/,/g, ''));
}

describe('the figures it states', () => {
  // The direction matters more than the precision. Rounding a price DOWN
  // quotes a creator less than they will actually be asked for; "around
  // 4,000" was 55 sats under the estimator's own answer, which is the one
  // error a cost line must not make. Rounding up costs nothing: the surplus
  // returns as change.
  for (const rate of [1, 5]) {
    test(`at ${rate} sat/vB the copy never quotes below the estimator`, () => {
      expect(quoted(rate)).toBeGreaterThanOrEqual(quote(rate));
    });

    test(`at ${rate} sat/vB the copy rounds up, not away`, () => {
      // Within one 100-sat rounding step, so "around" stays true. A change to
      // the buffer, the postage or the default content size that moved the
      // real quote out of this band fails here rather than leaving a stale
      // price on the page.
      expect(quoted(rate) - quote(rate)).toBeLessThan(100);
    });
  }

  test('states the two rates it claims to', () => {
    expect(quoted(1)).toBe(4_100);
    expect(quoted(5)).toBe(18_100);
  });
});

  test('names the postage the estimate actually includes', () => {
    expect(demo.inscribeCost).toContain(`${POSTAGE_SATS}-sat output`);
  });

  test('says the figure is an estimate, because the rate it multiplies is live', () => {
    // `currentFeeRate` reads provider.estimateFee on every quote, so these
    // numbers move between one visitor and the next. A note that presented
    // them as a fixed price would be the dishonest version. Asserted as the
    // three things that have to be said, not as one exact phrasing.
    expect(demo.inscribeCost).toMatch(/around/i);
    expect(demo.inscribeCost).toMatch(/the rate moves|quoted live|estimate/i);
    expect(demo.inscribeCost).toMatch(/exact amount/i);
  });

  test('keeps the deposit copy’s two hard facts: one-time, and no refund', () => {
    expect(demo.inscribeCost).toMatch(/one-time/i);
    expect(demo.inscribeCost).toMatch(/refundable/i);
  });

  test('says what the button under it actually does — which is free', () => {
    // This line only ever renders in the simulated tier, directly beside a
    // button labelled "Run the simulation". Without saying so it read as that
    // button's price. It must separate the two before it quotes anything.
    const beforeFirstFigure = demo.inscribeCost.slice(0, demo.inscribeCost.indexOf('4,100'));
    expect(beforeFirstFigure).toMatch(/free/i);
    expect(demo.inscribeCost).toMatch(/for real/i);
  });

  test('promises nothing that signing in has to deliver', () => {
    // `demoTier('off', …).real` is false for everyone, so on a mock build the
    // note renders to signed-in visitors too. The sibling rule the subhead is
    // already tested against: only copy on a build with a real path may invite
    // someone to sign in for one.
    expect(demo.inscribeCost).not.toMatch(/sign in/i);
  });
});
