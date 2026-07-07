/**
 * Regression tests for issue #344: fee estimators charged P2WPKH sizes
 * (68 vB in / 31 vB out) for ALL segwit inputs, but isSegwitScriptPubKey
 * admits P2WSH and P2TR — a P2WSH-funded commit underpaid the requested rate
 * and could stall in the mempool with the reveal key stranded in memory.
 *
 * The invariant under test: for every supported script class, the estimated
 * fee must be >= (actual serialized vsize) * (requested fee rate).
 */
import { describe, test, expect } from 'bun:test';
import { createCommitTransaction } from '../../../src/bitcoin/transactions/commit';
import { PSBTBuilder } from '../../../src/bitcoin/PSBTBuilder';
import { selectUtxos as selectUtxosSmart } from '../../../src/bitcoin/utxo';
import {
  classifyScriptPubKey,
  inputVBytesForScriptPubKey,
  outputVBytesForAddress,
  P2TR_INPUT_VBYTES,
  P2WPKH_INPUT_VBYTES,
  P2WSH_INPUT_VBYTES
} from '../../../src/bitcoin/utxo';
import type { Utxo } from '../../../src/types/bitcoin';

const P2WPKH_SPK = '0014' + 'ab'.repeat(20);
const P2WSH_SPK = '0020' + 'cd'.repeat(32);
const P2TR_SPK = '5120' + 'ef'.repeat(32);

// Valid mainnet bech32 addresses
const P2WPKH_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const P2TR_ADDR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';

/**
 * Actual serialized vsize of a 2-of-3 P2WSH input, the common worst case:
 * 41 vB base (outpoint 36 + scriptSig len 1 + sequence 4) plus a witness of
 * [empty, 72-byte sig, 72-byte sig, 105-byte witness script] each with a
 * 1-byte length prefix, plus a 1-byte stack count: 254 witness bytes / 4 =
 * 63.5 vB → 104.5 vB total.
 */
const ACTUAL_P2WSH_INPUT_VSIZE = 41 + (1 + 1 + 73 + 73 + 106) / 4;

const utxo = (value: number, scriptPubKey: string, i = 0): Utxo => ({
  txid: `${'a'.repeat(62)}${i.toString().padStart(2, '0')}`,
  vout: i,
  value,
  scriptPubKey
});

describe('script classification helpers', () => {
  test('classifies P2WPKH / P2WSH / P2TR / legacy / unknown', () => {
    expect(classifyScriptPubKey(P2WPKH_SPK)).toBe('p2wpkh');
    expect(classifyScriptPubKey(P2WSH_SPK)).toBe('p2wsh');
    expect(classifyScriptPubKey(P2TR_SPK)).toBe('p2tr');
    expect(classifyScriptPubKey('76a914' + 'ab'.repeat(20) + '88ac')).toBe('legacy');
    expect(classifyScriptPubKey(undefined)).toBe('unknown');
  });

  test('input sizing: P2WSH is charged conservatively above its true serialized size', () => {
    expect(inputVBytesForScriptPubKey(P2WPKH_SPK)).toBe(P2WPKH_INPUT_VBYTES);
    expect(inputVBytesForScriptPubKey(P2TR_SPK)).toBe(P2TR_INPUT_VBYTES);
    expect(inputVBytesForScriptPubKey(P2WSH_SPK)).toBe(P2WSH_INPUT_VBYTES);
    expect(P2WSH_INPUT_VBYTES).toBeGreaterThanOrEqual(ACTUAL_P2WSH_INPUT_VSIZE);
  });

  test('output sizing by address class: P2TR/P2WSH outputs are 43 vB, not 31', () => {
    expect(outputVBytesForAddress(P2WPKH_ADDR)).toBe(31);
    expect(outputVBytesForAddress(P2TR_ADDR)).toBe(43);
    // Unknown forms err toward the largest standard output size.
    expect(outputVBytesForAddress('someopaquestring')).toBe(43);
  });
});

describe('createCommitTransaction with P2WSH funding (issue #344)', () => {
  test('fee for a P2WSH input covers the actual serialized vsize at the requested rate', async () => {
    const feeRate = 20;
    const result = await createCommitTransaction({
      content: Buffer.from('hello inscription'),
      contentType: 'text/plain',
      utxos: [utxo(200_000, P2WSH_SPK)],
      changeAddress: P2WPKH_ADDR,
      feeRate,
      network: 'mainnet'
    });

    expect(result.selectedUtxos.length).toBe(1);
    expect(result.commitPsbt.outputsLength).toBe(2); // commit + change

    // What the transaction will really serialize to once the 2-of-3 P2WSH
    // input is signed: overhead 10.5 + input 104.5 + P2TR commit output 43 +
    // P2WPKH change output 31.
    const actualVsize = Math.ceil(10.5 + ACTUAL_P2WSH_INPUT_VSIZE + 43 + 31);
    expect(result.fees.commit).toBeGreaterThanOrEqual(actualVsize * feeRate);
  });

  test('P2WSH-funded commit pays more than an identical P2WPKH-funded commit', async () => {
    const params = (spk: string) => ({
      content: Buffer.from('hello inscription'),
      contentType: 'text/plain',
      utxos: [utxo(200_000, spk)],
      changeAddress: P2WPKH_ADDR,
      feeRate: 10,
      network: 'mainnet' as const
    });
    const p2wsh = await createCommitTransaction(params(P2WSH_SPK));
    const p2wpkh = await createCommitTransaction(params(P2WPKH_SPK));
    expect(p2wsh.fees.commit).toBeGreaterThan(p2wpkh.fees.commit);
  });

  test('change output to a P2TR address is charged 43 vB, not 31 (PSBTBuilder)', () => {
    // createCommitTransaction cannot be used here: validating a bech32m
    // (P2TR) change address requires an ECC library not initialized in this
    // test environment. PSBTBuilder sizes outputs by address class without
    // validating them.
    const b = new PSBTBuilder();
    const build = (changeAddress: string) => b.build({
      utxos: [utxo(500_000, P2WPKH_SPK)],
      outputs: [{ address: P2WPKH_ADDR, value: 100_000 }],
      changeAddress,
      feeRate: 10,
      network: 'mainnet'
    });
    const p2trChange = build(P2TR_ADDR);
    const p2wpkhChange = build(P2WPKH_ADDR);
    // 12 extra vB at 10 sat/vB = 120 sats
    expect(p2trChange.fee).toBe(p2wpkhChange.fee + 120);
  });
});

describe('PSBTBuilder with P2WSH funding (issue #344)', () => {
  test('fee for a P2WSH input covers the actual serialized vsize at the requested rate', () => {
    const feeRate = 15;
    const b = new PSBTBuilder();
    const res = b.build({
      utxos: [utxo(500_000, P2WSH_SPK)],
      outputs: [{ address: P2WPKH_ADDR, value: 100_000 }],
      changeAddress: P2WPKH_ADDR,
      feeRate,
      network: 'mainnet'
    });
    // overhead 10 + P2WSH input 104.5 + two P2WPKH outputs 31 each
    const actualVsize = Math.ceil(10 + ACTUAL_P2WSH_INPUT_VSIZE + 31 + 31);
    expect(res.fee).toBeGreaterThanOrEqual(actualVsize * feeRate);
  });
});

describe('utxo.ts selectUtxos with P2WSH funding (issue #344)', () => {
  test('fee for a P2WSH input covers the actual serialized vsize at the requested rate', () => {
    const feeRate = 15;
    const res = selectUtxosSmart([utxo(500_000, P2WSH_SPK)], {
      feeRateSatsPerVb: feeRate,
      targetAmountSats: 100_000,
      changeAddress: P2WPKH_ADDR
    });
    const actualVsize = Math.ceil(10 + ACTUAL_P2WSH_INPUT_VSIZE + 31 + 31);
    expect(res.feeSats).toBeGreaterThanOrEqual(actualVsize * feeRate);
  });

  test('P2TR inputs are priced at 57.5 vB — cheaper than P2WPKH, never below actual', () => {
    const feeRate = 10;
    const p2tr = selectUtxosSmart([utxo(500_000, P2TR_SPK)], { feeRateSatsPerVb: feeRate, targetAmountSats: 100_000 });
    const p2wpkh = selectUtxosSmart([utxo(500_000, P2WPKH_SPK)], { feeRateSatsPerVb: feeRate, targetAmountSats: 100_000 });
    expect(p2tr.feeSats).toBeLessThan(p2wpkh.feeSats);
    // Actual key-path P2TR input is 57.5 vB (41 base + (1 + 1 + 64)/4
    // witness); real P2WPKH outputs are 31 vB each (the estimator's default
    // 34 vB/output already overpays them).
    const actualVsize = Math.ceil(10 + 57.5 + 31 + 31);
    expect(p2tr.feeSats).toBeGreaterThanOrEqual(actualVsize * feeRate);
  });
});
