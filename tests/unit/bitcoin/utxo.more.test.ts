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

  test('recompute change path yields non-dust change after single-output fee', () => {
    // fee(2 outs,1 input,fr=1)=226; fee(1 out)=192; choose initial change 530 (<546), after recompute becomes 564 (>=546)
    const target = 10_000;
    const utxos = [U(target + 226 + 530)];
    const res = selectUtxos(utxos, { targetAmountSats: target, feeRateSatsPerVb: 1 });
    expect(res.changeSats).toBeGreaterThanOrEqual(DUST_LIMIT_SATS);
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

