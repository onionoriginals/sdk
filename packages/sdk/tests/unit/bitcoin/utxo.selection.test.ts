/* istanbul ignore file */
import { describe, test, expect } from 'bun:test';
import { DUST_LIMIT_SATS, Utxo } from '../../../src/types';
import { selectUtxos, UtxoSelectionError } from '../../../src';

const U = (v: number, opts: Partial<Utxo> = {}): Utxo => ({ txid: 't', vout: Math.floor(Math.random()*1000), value: v, ...opts });

describe('UTXO selection', () => {
  test('throws TOO_LOW_FEE when fee rate is not positive', () => {
    expect(() => selectUtxos([U(1000)], { targetAmountSats: 600, feeRateSatsPerVb: 0 })).toThrow(new UtxoSelectionError('TOO_LOW_FEE'));
  });

  test('throws DUST_OUTPUT when target is below dust', () => {
    expect(() => selectUtxos([U(1000)], { targetAmountSats: DUST_LIMIT_SATS - 1, feeRateSatsPerVb: 1 })).toThrow(new UtxoSelectionError('DUST_OUTPUT'));
  });

  test('throws INSUFFICIENT_FUNDS when not enough value to cover fee+amount', () => {
    expect(() => selectUtxos([U(500)], { targetAmountSats: 600, feeRateSatsPerVb: 2 })).toThrow(new UtxoSelectionError('INSUFFICIENT_FUNDS'));
  });

  test('throws CONFLICTING_LOCKS when funds exist but are locked', () => {
    const utxos = [U(100000, { locked: true })];
    expect(() => selectUtxos(utxos, { targetAmountSats: 1000, feeRateSatsPerVb: 2 })).toThrow(new UtxoSelectionError('CONFLICTING_LOCKS'));
  });

  test('inscription safety: forbids inscription-bearing inputs if option set', () => {
    const utxos = [U(100000, { inscriptions: ['i1'] })];
    expect(() => selectUtxos(utxos, { targetAmountSats: 1000, feeRateSatsPerVb: 2, forbidInscriptionBearingInputs: true })).toThrow(new UtxoSelectionError('INSUFFICIENT_FUNDS'));
  });

  test('inscription safety: inscription-bearing inputs are excluded by default', () => {
    const utxos = [U(100000, { inscriptions: ['i1'] })];
    expect(() => selectUtxos(utxos, { targetAmountSats: 1000, feeRateSatsPerVb: 2 })).toThrow(new UtxoSelectionError('INSUFFICIENT_FUNDS'));
  });

  test('inscription safety: prefers clean UTXOs over a larger inscribed one by default', () => {
    const inscribed = U(100000, { inscriptions: ['i1'] });
    const clean = U(20000);
    const res = selectUtxos([inscribed, clean], { targetAmountSats: 1000, feeRateSatsPerVb: 2 });
    expect(res.selected).toEqual([clean]);
  });

  test('inscription safety: explicit opt-out still allows spending inscribed UTXOs', () => {
    const utxos = [U(100000, { inscriptions: ['i1'] })];
    const res = selectUtxos(utxos, { targetAmountSats: 1000, feeRateSatsPerVb: 2, forbidInscriptionBearingInputs: false });
    expect(res.selected.length).toBe(1);
  });

  test('returns selection with change suppressed if dust', () => {
    const utxos = [U(10000)];
    const res = selectUtxos(utxos, { targetAmountSats: DUST_LIMIT_SATS, feeRateSatsPerVb: 1 });
    expect(res.selected.length).toBeGreaterThan(0);
    expect(res.changeSats).toBeGreaterThanOrEqual(0);
  });
});

