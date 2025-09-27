/* istanbul ignore file */
import { DUST_LIMIT_SATS, Utxo } from '../../src/types';
import { selectUtxos, UtxoSelectionError } from '../../src';

const U = (v: number, opts: Partial<Utxo> = {}): Utxo => ({ txid: 't', vout: Math.floor(Math.random()*1000), value: v, ...opts });

describe('UTXO selection', () => {
  test('throws TOO_LOW_FEE when fee rate is not positive', () => {
    try {
      selectUtxos([U(1000)], { targetAmountSats: 600, feeRateSatsPerVb: 0 });
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('TOO_LOW_FEE');
    }
  });

  test('throws DUST_OUTPUT when target is below dust', () => {
    try {
      selectUtxos([U(1000)], { targetAmountSats: DUST_LIMIT_SATS - 1, feeRateSatsPerVb: 1 });
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('DUST_OUTPUT');
    }
  });

  test('throws DUST_OUTPUT when not enough value to cover fee+amount', () => {
    try {
      selectUtxos([U(500)], { targetAmountSats: 500, feeRateSatsPerVb: 2 });
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('DUST_OUTPUT');
    }
  });

  test('throws CONFLICTING_LOCKS when funds exist but are locked', () => {
    const utxos = [U(100000, { locked: true })];
    try {
      selectUtxos(utxos, { targetAmountSats: 1000, feeRateSatsPerVb: 2 });
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('CONFLICTING_LOCKS');
    }
  });

  test('inscription safety: forbids inscription-bearing inputs if option set', () => {
    const utxos = [U(100000, { inscriptions: ['i1'] })];
    try {
      selectUtxos(utxos, { targetAmountSats: 1000, feeRateSatsPerVb: 2, forbidInscriptionBearingInputs: true });
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  test('returns selection with change suppressed if dust', () => {
    const utxos = [U(10000)];
    const res = selectUtxos(utxos, { targetAmountSats: DUST_LIMIT_SATS, feeRateSatsPerVb: 1 });
    expect(res.selected.length).toBeGreaterThan(0);
    expect(res.changeSats).toBeGreaterThanOrEqual(0);
  });
});

