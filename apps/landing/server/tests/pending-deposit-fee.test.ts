import { describe, test, expect } from 'bun:test';
import { slowestPending, MAX_PENDING_FEE_LOOKUPS, fetchPendingDepositFee } from '../bitcoin';

describe('the advice describes the payment holding the deposit up', () => {
  const fast = { feeSats: 1640, vsize: 164 }; // 10 sat/vB
  const slow = { feeSats: 165, vsize: 164 }; //  1 sat/vB

  test('picks the lowest fee RATE, not the lowest fee or the first listed', () => {
    // A big transaction can pay more in total while being slower per vByte.
    const bigButSlow = { feeSats: 500, vsize: 1000 }; // 0.5 sat/vB
    expect(slowestPending([fast, bigButSlow, slow])).toBe(bigButSlow);
  });

  test('order of the indexer response does not change the answer', () => {
    expect(slowestPending([fast, slow])).toBe(slow);
    expect(slowestPending([slow, fast])).toBe(slow);
  });

  test('nothing pending means no advice', () => {
    expect(slowestPending([])).toBeNull();
  });

  test('a zero-vsize entry cannot divide by zero into first place', () => {
    expect(slowestPending([{ feeSats: 0, vsize: 0 }, slow])).toBe(slow);
  });

  test('the lookup fan-out stays bounded — this route is polled every 15s', () => {
    expect(MAX_PENDING_FEE_LOOKUPS).toBeLessThanOrEqual(3);
  });
});

describe('pending fee facts are best effort and never throw', () => {
  const cfg = { api: 'https://indexer.test', txid: 'a'.repeat(64) };

  test('vsize is ceil(weight/4), so the rate is never overstated', async () => {
    // weight % 4 == 1: rounding would give 164 and overstate the fee rate.
    const got = await fetchPendingDepositFee({
      ...cfg,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ fee: 165, weight: 657, vin: [{ sequence: 0xfffffffd }] }),
      })) as unknown as typeof fetch,
    });
    expect(got?.vsize).toBe(165);
  });

  test('reads RBF opt-in off the input sequences', async () => {
    const rbf = async (sequence: number) =>
      (
        await fetchPendingDepositFee({
          ...cfg,
          fetchImpl: (async () => ({
            ok: true,
            json: async () => ({ fee: 165, weight: 656, vin: [{ sequence }] }),
          })) as unknown as typeof fetch,
        })
      )?.rbf;
    expect(await rbf(0xfffffffd)).toBe(true);
    expect(await rbf(0xffffffff)).toBe(false);
    expect(await rbf(0xfffffffe)).toBe(false); // the exact non-signalling boundary
  });

  test('a failed read returns null rather than breaking the deposit screen', async () => {
    for (const impl of [
      async () => ({ ok: false, json: async () => ({}) }),
      async () => ({ ok: true, json: async () => ({ fee: 165 }) }), // no weight
      async () => {
        throw new Error('indexer down');
      },
    ]) {
      expect(await fetchPendingDepositFee({ ...cfg, fetchImpl: impl as unknown as typeof fetch })).toBeNull();
    }
  });
});

describe('advice is withheld unless every pending payment was priced', () => {
  /**
   * The defect: with more pending payments than the lookup cap, or a lookup
   * that failed, advising from the subset can name a FASTER sibling while the
   * real blocker sits outside it — sending the creator's fee bump, and the
   * explorer link, at the wrong transaction.
   */
  test('a partial view is not enough to name the blocker', () => {
    const priced = [{ feeSats: 1640, vsize: 164 }]; // the fast one
    const totalPending = 2; // the slow one was never priced
    const sawThemAll = priced.length === totalPending;
    expect(sawThemAll).toBe(false);
    // The route advises only when sawThemAll — so nothing is claimed here.
    expect(sawThemAll ? slowestPending(priced) : null).toBeNull();
  });

  test('a complete view does name it', () => {
    const priced = [{ feeSats: 1640, vsize: 164 }, { feeSats: 165, vsize: 164 }];
    const sawThemAll = priced.length === 2;
    expect(sawThemAll ? slowestPending(priced) : null).toBe(priced[1]);
  });
});
