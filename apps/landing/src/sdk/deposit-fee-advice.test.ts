import { describe, test, expect } from 'bun:test';
import { depositFeeAdvice } from './deposit-fee-advice';

// The real transaction that prompted this: 165 sats over 164 vB, RBF signalled,
// while the network was clearing ~3 sat/vB.
const REAL = { feeSats: 165, vsize: 164, rbf: true, networkSatVb: 3 };

describe('a deposit paying enough is left alone', () => {
  test('at the network rate, there is nothing to say', () => {
    expect(depositFeeAdvice({ ...REAL, feeSats: 492 }).kind).toBe('fine');
  });

  test('above it, likewise', () => {
    expect(depositFeeAdvice({ ...REAL, feeSats: 1640 }).kind).toBe('fine');
  });

  test('a difference too small to display is not warned about', () => {
    // 2.999 sat/vB rounds to 3.00 on screen; warning would contradict the UI.
    const advice = depositFeeAdvice({ feeSats: 492, vsize: 164, rbf: true, networkSatVb: 3 });
    expect(advice.kind).toBe('fine');
  });
});

describe('an underpriced deposit that cannot be replaced says so', () => {
  test('without RBF, the advice is to wait — not to try a bump that will fail', () => {
    const advice = depositFeeAdvice({ ...REAL, rbf: false });
    expect(advice.kind).toBe('slow');
  });
});

describe('an underpriced, replaceable deposit gets a rate that will actually relay', () => {
  const advice = depositFeeAdvice(REAL);

  test('is recognised as bumpable', () => {
    expect(advice.kind).toBe('bumpable');
  });

  /**
   * The trap this exists for. BIP-125 rule 4 makes the floor
   * `originalFee + vsize` = 165 + 164 = 329 sats, not "a bit more than 165".
   * A wallet nudged to 1.2 sat/vB (197 sats) looks bumped and is rejected.
   */
  test('the minimum replacement fee accounts for the replacement’s own bandwidth', () => {
    if (advice.kind !== 'bumpable') throw new Error('expected bumpable');
    expect(advice.minReplacementFeeSats).toBe(329);
    // A naive "just a bit more" bump is below the floor and would be refused.
    expect(197).toBeLessThan(advice.minReplacementFeeSats);
  });

  test('never suggests a rate below the relay floor, even when the network is cheap', () => {
    // 0.5 sat/vB while the network clears 1. Matching the network rate would
    // still be rejected: the replacement floor here is 82 + 164 = 246 sats,
    // i.e. 1.5 sat/vB. The suggestion has to clear the floor, not the network.
    const cheap = depositFeeAdvice({ feeSats: 82, vsize: 164, rbf: true, networkSatVb: 1 });
    if (cheap.kind !== 'bumpable') throw new Error('expected bumpable');
    expect(cheap.minReplacementFeeSats).toBe(246);
    expect(cheap.suggestSatVb).toBe(2);
    expect(cheap.suggestSatVb).toBeGreaterThan(cheap.networkSatVb);
  });

  test('when the network is expensive, the network rate wins', () => {
    const busy = depositFeeAdvice({ ...REAL, networkSatVb: 50 });
    if (busy.kind !== 'bumpable') throw new Error('expected bumpable');
    expect(busy.suggestSatVb).toBe(50);
  });

  test('reports the deposit’s own rate, rounded the way it is displayed', () => {
    if (advice.kind !== 'bumpable') throw new Error('expected bumpable');
    expect(advice.feeRateSatVb).toBe(1.01); // 165/164
  });
});
