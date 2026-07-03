import { describe, test, expect } from 'bun:test';
import { estimateFeeSats, selectUtxos, isSegwitScriptPubKey } from '../../../src/bitcoin/utxo';
import { PSBTBuilder } from '../../../src/bitcoin/PSBTBuilder';
import { DUST_LIMIT_SATS, Utxo } from '../../../src/types';

const U = (v: number, opts: Partial<Utxo> = {}): Utxo => ({ txid: 't', vout: 0, value: v, ...opts });

// Representative scriptPubKeys
const P2WPKH = '0014' + 'ab'.repeat(20);
const P2WSH = '0020' + 'ab'.repeat(32);
const P2TR = '5120' + 'ab'.repeat(32);
const P2PKH = '76a914' + 'ab'.repeat(20) + '88ac';
const P2SH = 'a914' + 'ab'.repeat(20) + '87';

describe('isSegwitScriptPubKey', () => {
  test('accepts witness programs (P2WPKH/P2WSH/P2TR)', () => {
    expect(isSegwitScriptPubKey(P2WPKH)).toBe(true);
    expect(isSegwitScriptPubKey(P2WSH)).toBe(true);
    expect(isSegwitScriptPubKey(P2TR)).toBe(true);
  });

  test('rejects legacy scripts and malformed hex', () => {
    expect(isSegwitScriptPubKey(P2PKH)).toBe(false);
    expect(isSegwitScriptPubKey(P2SH)).toBe(false);
    expect(isSegwitScriptPubKey('')).toBe(false);
    expect(isSegwitScriptPubKey('0014zz')).toBe(false);
    // version opcode with wrong program length
    expect(isSegwitScriptPubKey('0014' + 'ab'.repeat(19))).toBe(false);
  });
});

describe('non-segwit funding UTXO rejection', () => {
  test('selectUtxos excludes UTXOs with legacy scriptPubKeys', () => {
    const utxos = [
      U(100000, { scriptPubKey: P2PKH }),
      U(100000, { scriptPubKey: P2WPKH, txid: 't2' })
    ];
    const res = selectUtxos(utxos, { targetAmountSats: 1000, feeRateSatsPerVb: 1 });
    expect(res.selected).toHaveLength(1);
    expect(res.selected[0].txid).toBe('t2');
  });

  test('selectUtxos with only legacy UTXOs fails with INSUFFICIENT_FUNDS', () => {
    const utxos = [U(100000, { scriptPubKey: P2PKH })];
    expect(() => selectUtxos(utxos, { targetAmountSats: 1000, feeRateSatsPerVb: 1 }))
      .toThrow('INSUFFICIENT_FUNDS');
  });

  test('PSBTBuilder rejects legacy funding UTXOs with a clear error', () => {
    const builder = new PSBTBuilder();
    expect(() => builder.build({
      utxos: [U(100000, { scriptPubKey: P2PKH })],
      outputs: [{ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', value: 1000 }],
      changeAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      feeRate: 1,
      network: 'regtest'
    })).toThrow('Non-segwit (legacy) funding UTXOs are not supported');
  });
});

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
    // An input with no scriptPubKey is unclassified and priced conservatively
    // at legacy width: fee(2 outs, 1 input, fr=1) = 10 + 148 + 2*34 = 226.
    // Change would be 530 (<546 dust limit), so no change output is created
    // and the full remainder is fee.
    const target = 10_000;
    const utxos = [U(target + 226 + 530)];
    const res = selectUtxos(utxos, { targetAmountSats: target, feeRateSatsPerVb: 1 });
    expect(res.changeSats).toBe(0);
    // Reported fee matches what the transaction actually pays.
    expect(res.feeSats).toBe(226 + 530);
  });

  test('non-dust change is priced with the two-output fee (unclassified input at legacy width)', () => {
    const target = 10_000;
    const utxos = [U(target + 226 + 1000)];
    const res = selectUtxos(utxos, { targetAmountSats: target, feeRateSatsPerVb: 1 });
    expect(res.feeSats).toBe(226);
    expect(res.changeSats).toBe(1000);
  });

  test('a verified segwit input is priced at witness width (68 vB)', () => {
    // fee(2 outs, 1 segwit input, fr=1) = 10 + 68 + 2*34 = 146.
    const target = 10_000;
    const utxos = [U(target + 146 + 1000, { scriptPubKey: P2WPKH })];
    const res = selectUtxos(utxos, { targetAmountSats: target, feeRateSatsPerVb: 1 });
    expect(res.feeSats).toBe(146);
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

