/**
 * Bitcoin UTXO selection performance tests
 *
 * Covers: BITCOIN-009, BITCOIN-010, BITCOIN-013/performance
 *
 * These tests assert CORRECTNESS on large inputs, not wall-clock thresholds.
 * Timing assertions are intentionally absent to avoid CI flakiness.
 */
import { describe, test, expect } from 'bun:test';
import {
  selectUtxosSimple,
  selectResourceUtxos,
  calculateFee,
  estimateTransactionSize,
} from '../../src';
import type { Utxo, ResourceUtxo } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeUtxo(value: number, index: number): Utxo {
  return {
    txid: `tx${index.toString(16).padStart(8, '0')}`,
    vout: index % 4,
    value,
  };
}

function makeResourceUtxo(value: number, index: number, hasResource = false): ResourceUtxo {
  return {
    txid: `rtx${index.toString(16).padStart(8, '0')}`,
    vout: index % 4,
    value,
    hasResource,
  };
}

// ---------------------------------------------------------------------------
// [BITCOIN-009/performance] selectUtxos from large set (1000+ UTXOs)
// ---------------------------------------------------------------------------
describe('BITCOIN-009: UTXO selection from large set', () => {
  test('selects correct UTXOs from 1000 UTXOs to cover target amount', () => {
    const utxos: Utxo[] = Array.from({ length: 1000 }, (_, i) =>
      makeUtxo(10_000 + i, i) // values 10000..10999
    );
    const targetAmount = 500_000;

    const result = selectUtxosSimple(utxos, { targetAmount, strategy: 'minimize_inputs' });

    expect(result.totalInputValue).toBeGreaterThanOrEqual(targetAmount);
    expect(result.selectedUtxos.length).toBeGreaterThan(0);
    // minimize_inputs: picks largest values first
    const totalValue = result.selectedUtxos.reduce((sum, u) => sum + u.value, 0);
    expect(totalValue).toBe(result.totalInputValue);
    expect(result.changeAmount).toBe(result.totalInputValue - targetAmount);
  });

  test('selects correct UTXOs from 1000 UTXOs with minimize_change strategy', () => {
    const utxos: Utxo[] = Array.from({ length: 1000 }, (_, i) =>
      makeUtxo(1_000 + i * 100, i) // values 1000, 1100, ..., 100900
    );
    const targetAmount = 50_000;

    const result = selectUtxosSimple(utxos, { targetAmount, strategy: 'minimize_change' });

    expect(result.totalInputValue).toBeGreaterThanOrEqual(targetAmount);
    // change should be small (minimize_change picks smallest first)
    expect(result.changeAmount).toBeLessThan(targetAmount);
  });

  test('handles 2000 UTXOs without error', () => {
    const utxos: Utxo[] = Array.from({ length: 2000 }, (_, i) =>
      makeUtxo(5_000, i) // all same value
    );
    const targetAmount = 1_000_000;

    const result = selectUtxosSimple(utxos, { targetAmount });

    expect(result.totalInputValue).toBeGreaterThanOrEqual(targetAmount);
    expect(result.selectedUtxos.length).toBeGreaterThan(0);
  });

  test('throws Insufficient funds on 1000 UTXOs with inadequate total', () => {
    const utxos: Utxo[] = Array.from({ length: 1000 }, (_, i) =>
      makeUtxo(1, i) // 1 sat each → total 1000 sat
    );

    expect(() => selectUtxosSimple(utxos, { targetAmount: 2000 })).toThrow(/Insufficient funds/i);
  });

  test('respects maxNumUtxos on large set', () => {
    const utxos: Utxo[] = Array.from({ length: 1000 }, (_, i) =>
      makeUtxo(100_000, i)
    );

    const result = selectUtxosSimple(utxos, { targetAmount: 50_000, maxNumUtxos: 2 });

    expect(result.selectedUtxos.length).toBeLessThanOrEqual(2);
    expect(result.totalInputValue).toBeGreaterThanOrEqual(50_000);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-010/performance] Resource UTXO selection with advanced strategies on 1000+ UTXOs
// ---------------------------------------------------------------------------
describe('BITCOIN-010: resource-aware UTXO selection on large set', () => {
  test('excludes resource UTXOs from 1000-item set and selects correct change', () => {
    // 900 resource UTXOs (should be excluded) + 100 clean UTXOs
    const utxos: ResourceUtxo[] = [
      ...Array.from({ length: 900 }, (_, i) => makeResourceUtxo(10_000, i, true)),
      ...Array.from({ length: 100 }, (_, i) => makeResourceUtxo(10_000, 900 + i, false)),
    ];

    const result = selectResourceUtxos(utxos, {
      requiredAmount: 50_000,
      feeRate: 5,
      allowResourceUtxos: false,
    });

    expect(result.selectedUtxos.every(u => !u.hasResource)).toBe(true);
    expect(result.totalSelectedValue).toBeGreaterThanOrEqual(50_000);
  });

  test('preferCloserAmount strategy works on large set', () => {
    const utxos: ResourceUtxo[] = Array.from({ length: 1000 }, (_, i) =>
      makeResourceUtxo(5_000 + i * 10, i, false)
    );
    const requiredAmount = 50_000;

    const result = selectResourceUtxos(utxos, {
      requiredAmount,
      feeRate: 2,
      preferCloserAmount: true,
    });

    expect(result.totalSelectedValue).toBeGreaterThanOrEqual(requiredAmount);
    expect(result.selectedUtxos.length).toBeGreaterThan(0);
  });

  test('preferOlder strategy works on large set (sorts by txid lexicographically)', () => {
    const utxos: ResourceUtxo[] = Array.from({ length: 500 }, (_, i) =>
      makeResourceUtxo(20_000, i, false)
    );

    const result = selectResourceUtxos(utxos, {
      requiredAmount: 10_000,
      feeRate: 1,
      preferOlder: true,
    });

    expect(result.selectedUtxos.length).toBeGreaterThan(0);
    // First selected UTXO should be lexicographically smallest txid
    const firstTxid = result.selectedUtxos[0].txid;
    const allTxids = utxos.map(u => u.txid).sort((a, b) => a.localeCompare(b));
    expect(firstTxid).toBe(allTxids[0]);
  });

  test('handles 2000 mixed UTXOs correctly (50% resource, 50% clean)', () => {
    const utxos: ResourceUtxo[] = Array.from({ length: 2000 }, (_, i) =>
      makeResourceUtxo(3_000, i, i % 2 === 0) // alternating
    );

    const result = selectResourceUtxos(utxos, {
      requiredAmount: 100_000,
      feeRate: 3,
      allowResourceUtxos: false,
    });

    expect(result.selectedUtxos.every(u => !u.hasResource)).toBe(true);
    expect(result.totalSelectedValue).toBeGreaterThanOrEqual(100_000);
  });

  test('dust (sub-546 sat change) is folded into fee on large set', () => {
    // Create UTXOs where change would fall below dust limit
    const utxos: ResourceUtxo[] = [
      makeResourceUtxo(10_200, 0, false),
    ];

    const result = selectResourceUtxos(utxos, {
      requiredAmount: 9_800, // leaves small change potentially below dust
      feeRate: 1.1,
    });

    // Change is either 0 (absorbed into fee) or ≥ 546 (dust limit)
    if (result.changeAmount > 0) {
      expect(result.changeAmount).toBeGreaterThanOrEqual(546);
    } else {
      expect(result.changeAmount).toBe(0);
    }
    expect(result.totalSelectedValue).toBe(10_200);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-013/performance] Batch fee calculation throughput
// ---------------------------------------------------------------------------
describe('BITCOIN-013/performance: batch fee calculation', () => {
  test('calculates 10000 fees correctly with no errors', () => {
    const feeRates = [0.5, 1.0, 1.1, 2, 5, 10, 20, 50, 100, 500];
    const vbyteSizes = [68, 140, 208, 245, 400, 700, 1000, 2500, 5000, 10000];

    let errCount = 0;
    const results: bigint[] = [];

    for (let i = 0; i < 10_000; i++) {
      const feeRate = feeRates[i % feeRates.length];
      const vbytes = vbyteSizes[i % vbyteSizes.length];
      try {
        results.push(calculateFee(vbytes, feeRate));
      } catch {
        errCount++;
      }
    }

    expect(errCount).toBe(0);
    expect(results).toHaveLength(10_000);
    // All results are positive bigints ≥ 1n
    expect(results.every(f => f >= 1n)).toBe(true);
  });

  test('batch fee for 1000 transaction sizes maintains correct floor', () => {
    // Build a range of sizes from typical small tx to large ordinal envelope
    const sizes = Array.from({ length: 1000 }, (_, i) => 68 + i * 10); // 68..9968 vbytes
    const feeRate = 0.8; // below 1.1 minimum — all should use relay floor

    const fees = sizes.map(vbytes => calculateFee(vbytes, feeRate));

    // Each fee should be >= ceil(vbytes * 1.1) (relay floor)
    for (let i = 0; i < sizes.length; i++) {
      const minRelayFee = BigInt(Math.ceil(sizes[i] * 1.1));
      expect(fees[i]).toBeGreaterThanOrEqual(minRelayFee);
    }
  });

  test('estimateTransactionSize scales linearly for 1000 input counts', () => {
    // For each count 1..1000, verify formula is consistent
    for (let inputs = 1; inputs <= 1000; inputs += 50) {
      const size = estimateTransactionSize(inputs, 2);
      const expected = 10 + inputs * 68 + 2 * 31;
      expect(size).toBe(expected);
    }
  });
});
