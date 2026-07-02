import { describe, test, expect } from 'bun:test';
import { estimateFeeSats, selectUtxos } from '../../../src/bitcoin/utxo';
import { DUST_LIMIT_SATS, Utxo } from '../../../src/types';

const U = (v: number, opts: Partial<Utxo> = {}): Utxo => ({ txid: 't', vout: 0, value: v, ...opts });

describe('UTXO selection additional branches', () => {
  test('uses locked inputs when allowLocked=true', () => {
    const utxos = [U(100000, { locked: true })];
    const res = selectUtxos(utxos, { targetAmountSats: 1000, feeRateSatsPerVb: 1, allowLocked: true });
    expect(res.selected[0].locked).toBe(true);
  });

  test('includes inscription-bearing inputs when not forbidden', () => {
    const utxos = [U(100000, { inscriptions: ['i1'] })];
    const res = selectUtxos(utxos, { targetAmountSats: DUST_LIMIT_SATS, feeRateSatsPerVb: 1, forbidInscriptionBearingInputs: false });
    expect(res.selected.length).toBeGreaterThan(0);
  });

  test('dust change is dropped and folded into the reported fee', () => {
    // fee(2 outs,1 input,fr=1)=226; change would be 530 (<546 dust limit),
    // so no change output is created and the full remainder is fee.
    const target = 10_000;
    const utxos = [U(target + 226 + 530)];
    const res = selectUtxos(utxos, { targetAmountSats: target, feeRateSatsPerVb: 1 });
    expect(res.changeSats).toBe(0);
    // Reported fee matches what the transaction actually pays.
    expect(res.feeSats).toBe(226 + 530);
  });

  test('non-dust change is priced with the two-output fee', () => {
    const target = 10_000;
    const utxos = [U(target + 226 + 1000)];
    const res = selectUtxos(utxos, { targetAmountSats: target, feeRateSatsPerVb: 1 });
    expect(res.feeSats).toBe(226);
    expect(res.changeSats).toBe(1000);
  });

  test('estimateFeeSats honors overrides', () => {
    const base = estimateFeeSats(1, 2, 1);
    const overridden = estimateFeeSats(1, 2, 1, { bytesPerInput: 200, bytesPerOutput: 50, baseTxBytes: 12 });
    expect(overridden).toBeGreaterThan(base);
  });

  test('UtxoSelectionError message defaults to code when not provided', () => {
    const err = new (require('../../../src/bitcoin/utxo').UtxoSelectionError)('SAT_SAFETY');
    expect(err.message).toBe('SAT_SAFETY');
  });
});

