/**
 * U15 / R26 — a deposit a stranger can actually spend.
 *
 * The selection that funds an inscription is the one place where a creator's
 * real BTC can sit at their own address and still be unspendable: picking ONE
 * confirmed UTXO large enough to cover the whole cost means two smaller
 * payments — or a top-up after a fee rise — leave them permanently told to
 * deposit more while their coins sit there. Every layer beneath now takes a
 * SET (U16); these tests pin the selection that uses it, and the ordinal
 * guard that summing makes load-bearing.
 */
import { describe, test, expect } from 'bun:test';
import { selectFundingUtxos, type FundingUtxo } from './Demo';

const SCRIPT = '0014' + '11'.repeat(20);
const utxo = (n: number, value: number): FundingUtxo => ({
  txid: String(n).repeat(64).slice(0, 64),
  vout: 0,
  value,
  scriptPubKey: SCRIPT,
});

describe('selectFundingUtxos (R26)', () => {
  test('two confirmed UTXOs that individually fall short but jointly cover the cost fund it', () => {
    const a = utxo(1, 6_000);
    const b = utxo(2, 6_000);
    const out = selectFundingUtxos([a, b], 10_000);
    expect(out.shortfallSats).toBe(0);
    expect(out.totalSats).toBe(12_000);
    expect(out.selected.map((u) => u.txid)).toEqual([a.txid, b.txid]);
  });

  test('one UTXO that covers the cost on its own is still selected alone', () => {
    const big = utxo(3, 50_000);
    const small = utxo(4, 900);
    const out = selectFundingUtxos([small, big], 10_000);
    expect(out.selected).toEqual([big]);
    expect(out.totalSats).toBe(50_000);
    expect(out.shortfallSats).toBe(0);
  });

  test('a top-up arriving after a short deposit unblocks the flow on the next poll', () => {
    const first = utxo(5, 4_000);
    const before = selectFundingUtxos([first], 10_000);
    expect(before.selected).toEqual([]);
    expect(before.shortfallSats).toBe(6_000);

    // Same poll shape, one more confirmed output at the address.
    const topUp = utxo(6, 7_000);
    const after = selectFundingUtxos([first, topUp], 10_000);
    expect(after.shortfallSats).toBe(0);
    expect(after.selected).toHaveLength(2);
  });

  test('jointly still short: nothing is selected and the shortfall is named', () => {
    const out = selectFundingUtxos([utxo(7, 3_000), utxo(8, 2_000)], 10_000);
    expect(out.selected).toEqual([]);
    expect(out.totalSats).toBe(5_000);
    expect(out.shortfallSats).toBe(5_000);
  });

  test('largest first: no more inputs are spent than the target needs', () => {
    const out = selectFundingUtxos([utxo(1, 3_000), utxo(2, 9_000), utxo(3, 3_000)], 10_000);
    // 9k + 3k covers it; the third output stays unspent.
    expect(out.selected).toHaveLength(2);
    expect(out.selected[0].value).toBe(9_000);
    expect(out.totalSats).toBe(12_000);
  });

  test('an empty spendable set is a shortfall of the whole target, never a selection', () => {
    const out = selectFundingUtxos([], 10_000);
    expect(out.selected).toEqual([]);
    expect(out.totalSats).toBe(0);
    expect(out.shortfallSats).toBe(10_000);
  });
});
