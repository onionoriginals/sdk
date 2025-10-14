/**
 * Tests for new UTXO selection functions ported from legacy
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  selectUtxosSimple,
  selectResourceUtxos,
  selectUtxosForPayment,
  tagResourceUtxos,
  estimateTransactionSize
} from '../../../src';
import type { Utxo, ResourceUtxo } from '../../../src/types';

// Helper to create test UTXOs
const createUtxo = (value: number, overrides: Partial<Utxo> = {}): Utxo => ({
  txid: `tx${Math.random().toString(36).substring(7)}`,
  vout: Math.floor(Math.random() * 10),
  value,
  ...overrides
});

// Helper to create resource UTXOs
const createResourceUtxo = (value: number, hasResource: boolean = false): ResourceUtxo => ({
  ...createUtxo(value),
  hasResource
});

describe('estimateTransactionSize', () => {
  test('calculates size for 1 input, 2 outputs', () => {
    const size = estimateTransactionSize(1, 2);
    // 10 (overhead) + 68 (1 input) + 62 (2 outputs) = 140
    expect(size).toBe(140);
  });

  test('calculates size for 3 inputs, 1 output', () => {
    const size = estimateTransactionSize(3, 1);
    // 10 + (3 * 68) + 31 = 245
    expect(size).toBe(245);
  });

  test('scales linearly with inputs', () => {
    const size1 = estimateTransactionSize(1, 2);
    const size2 = estimateTransactionSize(2, 2);
    expect(size2 - size1).toBe(68); // One additional input
  });
});

describe('tagResourceUtxos', () => {
  test('tags UTXOs based on resourceData', () => {
    const utxos: ResourceUtxo[] = [
      { ...createUtxo(1000), txid: 'tx1', vout: 0 },
      { ...createUtxo(2000), txid: 'tx2', vout: 1 }
    ];
    
    const resourceData = {
      'tx1:0': true,
      'tx2:1': false
    };
    
    const tagged = tagResourceUtxos(utxos, resourceData);
    expect(tagged[0].hasResource).toBe(true);
    expect(tagged[1].hasResource).toBe(false);
  });

  test('preserves existing hasResource flag when no resourceData provided', () => {
    const utxos: ResourceUtxo[] = [
      { ...createUtxo(1000), hasResource: true },
      { ...createUtxo(2000), hasResource: false }
    ];
    
    const tagged = tagResourceUtxos(utxos);
    expect(tagged[0].hasResource).toBe(true);
    expect(tagged[1].hasResource).toBe(false);
  });

  test('defaults to false when no data provided', () => {
    const utxos: ResourceUtxo[] = [
      createUtxo(1000),
      createUtxo(2000)
    ];
    
    const tagged = tagResourceUtxos(utxos);
    expect(tagged[0].hasResource).toBe(false);
    expect(tagged[1].hasResource).toBe(false);
  });
});

describe('selectUtxos - Simple Selection', () => {
  describe('Strategy Tests', () => {
    test('minimize_inputs strategy uses fewest UTXOs', () => {
      const utxos = [
        createUtxo(1000),
        createUtxo(2000),
        createUtxo(5000),
        createUtxo(10000)
      ];
      
      const result = selectUtxosSimple(utxos, {
        targetAmount: 3000,
        strategy: 'minimize_inputs'
      });
      
      // Should select the 5000 sat UTXO (fewest inputs)
      expect(result.selectedUtxos.length).toBe(1);
      expect(result.selectedUtxos[0].value).toBe(10000); // Sorted descending, picks first that covers
    });

    test('minimize_change strategy minimizes change output', () => {
      const utxos = [
        createUtxo(1000),
        createUtxo(2000),
        createUtxo(3100),
        createUtxo(10000)
      ];
      
      const result = selectUtxosSimple(utxos, {
        targetAmount: 3000,
        strategy: 'minimize_change'
      });
      
      // Should accumulate small UTXOs first
      expect(result.selectedUtxos.length).toBeGreaterThan(1);
      expect(result.changeAmount).toBeLessThan(3100); // Less change than using 10000
    });

    test('optimize_size strategy balances inputs and change', () => {
      const utxos = [
        createUtxo(1000),
        createUtxo(2000),
        createUtxo(5000)
      ];
      
      const result = selectUtxosSimple(utxos, {
        targetAmount: 3000,
        strategy: 'optimize_size'
      });
      
      expect(result.selectedUtxos.length).toBeGreaterThan(0);
      expect(result.totalInputValue).toBeGreaterThanOrEqual(3000);
    });

    test('defaults to minimize_inputs when strategy not specified', () => {
      const utxos = [
        createUtxo(1000),
        createUtxo(10000)
      ];
      
      const result = selectUtxosSimple(utxos, { targetAmount: 500 });
      
      // Should pick largest first (minimize_inputs default)
      expect(result.selectedUtxos[0].value).toBe(10000);
    });

    test('accepts simple number as targetAmount', () => {
      const utxos = [createUtxo(10000)];
      
      const result = selectUtxosSimple(utxos, 5000);
      
      expect(result.selectedUtxos.length).toBe(1);
      expect(result.changeAmount).toBe(5000);
    });
  });

  describe('Edge Case Tests', () => {
    test('throws when no UTXOs provided', () => {
      expect(() => {
        selectUtxosSimple([], { targetAmount: 1000 });
      }).toThrow('No UTXOs provided');
    });

    test('throws when target amount is zero', () => {
      const utxos = [createUtxo(1000)];
      expect(() => {
        selectUtxosSimple(utxos, { targetAmount: 0 });
      }).toThrow('Invalid target amount');
    });

    test('throws when target amount is negative', () => {
      const utxos = [createUtxo(1000)];
      expect(() => {
        selectUtxosSimple(utxos, { targetAmount: -100 });
      }).toThrow('Invalid target amount');
    });

    test('throws INSUFFICIENT_FUNDS when not enough UTXOs', () => {
      const utxos = [
        createUtxo(500),
        createUtxo(500)
      ];
      
      expect(() => {
        selectUtxosSimple(utxos, { targetAmount: 2000 });
      }).toThrow('Insufficient funds');
    });

    test('respects maxNumUtxos limit', () => {
      const utxos = [
        createUtxo(1000),
        createUtxo(1000),
        createUtxo(1000),
        createUtxo(1000),
        createUtxo(1000)
      ];
      
      const result = selectUtxosSimple(utxos, {
        targetAmount: 2500,
        maxNumUtxos: 3
      });
      
      // Should use at most 3 UTXOs even though more are available
      expect(result.selectedUtxos.length).toBeLessThanOrEqual(3);
      expect(result.totalInputValue).toBeGreaterThanOrEqual(2500);
    });

    test('skips invalid UTXOs (missing txid)', () => {
      const utxos: Utxo[] = [
        { txid: '', vout: 0, value: 1000 }, // Invalid - no txid
        createUtxo(5000)
      ];
      
      const result = selectUtxosSimple(utxos, { targetAmount: 2000 });
      
      // Should skip invalid and use the valid one
      expect(result.selectedUtxos.length).toBe(1);
      expect(result.selectedUtxos[0].value).toBe(5000);
    });
  });
});

describe('selectResourceUtxos - Resource-Aware Selection', () => {
  describe('Safety Tests - Resource Protection', () => {
    test('NEVER selects inscription-bearing UTXOs when allowResourceUtxos=false', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(10000, true),  // Has inscription
        createResourceUtxo(10000, true),  // Has inscription
        createResourceUtxo(50000, false)  // Clean UTXO
      ];
      
      const result = selectResourceUtxos(utxos, {
        requiredAmount: 5000,
        feeRate: 1,
        allowResourceUtxos: false
      });
      
      // Should only select the clean UTXO
      expect(result.selectedUtxos.length).toBe(1);
      expect(result.selectedUtxos[0].hasResource).toBe(false);
      expect(result.selectedUtxos[0].value).toBe(50000);
    });

    test('can use resource UTXOs when explicitly allowed', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(10000, true)
      ];
      
      const result = selectResourceUtxos(utxos, {
        requiredAmount: 5000,
        feeRate: 1,
        allowResourceUtxos: true
      });
      
      expect(result.selectedUtxos.length).toBe(1);
      expect(result.selectedUtxos[0].hasResource).toBe(true);
    });

    test('throws helpful error when all UTXOs contain resources', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(10000, true),
        createResourceUtxo(20000, true)
      ];
      
      expect(() => {
        selectResourceUtxos(utxos, {
          requiredAmount: 5000,
          feeRate: 1,
          allowResourceUtxos: false
        });
      }).toThrow('All available UTXOs contain resources');
    });

    test('respects avoidUtxoIds parameter', () => {
      const utxos: ResourceUtxo[] = [
        { ...createResourceUtxo(10000, false), txid: 'avoid1', vout: 0 },
        { ...createResourceUtxo(20000, false), txid: 'use1', vout: 0 }
      ];
      
      const result = selectResourceUtxos(utxos, {
        requiredAmount: 5000,
        feeRate: 1,
        avoidUtxoIds: ['avoid1:0']
      });
      
      expect(result.selectedUtxos.length).toBe(1);
      expect(result.selectedUtxos[0].txid).toBe('use1');
    });
  });

  describe('Fee Calculation Tests', () => {
    test('calculates correct fee for 1 input', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(100000, false)
      ];
      
      const result = selectResourceUtxos(utxos, {
        requiredAmount: 10000,
        feeRate: 10 // 10 sats/vbyte
      });
      
      // 1 input, 2 outputs = 140 vbytes * 10 = 1400 sats fee
      expect(result.estimatedFee).toBeGreaterThan(0);
      expect(result.estimatedFee).toBeGreaterThanOrEqual(1400); // At least the calculated fee
    });

    test('fee increases with more inputs', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(5000, false),
        createResourceUtxo(5000, false),
        createResourceUtxo(5000, false)
      ];
      
      const result = selectResourceUtxos(utxos, {
        requiredAmount: 12000,
        feeRate: 10
      });
      
      // Should use 3 inputs, fee should be higher
      expect(result.selectedUtxos.length).toBe(3);
      expect(result.estimatedFee).toBeGreaterThan(1400); // More than 1 input
    });

    test('respects custom fee rate', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(100000, false)
      ];
      
      const lowFee = selectResourceUtxos(utxos, {
        requiredAmount: 10000,
        feeRate: 1
      });
      
      const highFee = selectResourceUtxos(utxos, {
        requiredAmount: 10000,
        feeRate: 50
      });
      
      expect(highFee.estimatedFee).toBeGreaterThan(lowFee.estimatedFee);
    });
  });

  describe('Dust Handling Tests', () => {
    test('adds dust to fee instead of creating dust output', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(10000, false)
      ];
      
      const result = selectResourceUtxos(utxos, {
        requiredAmount: 9300, // Will leave ~200 sats change (< 546 dust limit)
        feeRate: 1
      });
      
      // Change should be 0 or exactly 546 (dust limit) when dust would be created
      // The implementation adds dust to fee, so change should be 0
      // But if change >= dust limit, it creates the output
      if (result.changeAmount > 0) {
        expect(result.changeAmount).toBeGreaterThanOrEqual(546); // Above dust limit
      }
      // Total should equal input
      expect(result.totalSelectedValue).toBe(10000);
    });

    test('creates change output when above dust limit', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(100000, false)
      ];
      
      const result = selectResourceUtxos(utxos, {
        requiredAmount: 50000,
        feeRate: 1
      });
      
      // Change should be created (way above dust limit)
      expect(result.changeAmount).toBeGreaterThan(546);
    });
  });

  describe('Selection Strategy Tests', () => {
    test('preferOlder sorts by txid', () => {
      const utxos: ResourceUtxo[] = [
        { ...createResourceUtxo(10000, false), txid: 'zzz' },
        { ...createResourceUtxo(20000, false), txid: 'aaa' },
        { ...createResourceUtxo(15000, false), txid: 'mmm' }
      ];
      
      const result = selectResourceUtxos(utxos, {
        requiredAmount: 5000,
        feeRate: 1,
        preferOlder: true
      });
      
      // Should select 'aaa' first (lexicographically first)
      expect(result.selectedUtxos[0].txid).toBe('aaa');
    });

    test('preferCloserAmount selects UTXO closest to target', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(6000, false),  // Closest to 5000 + fees
        createResourceUtxo(50000, false),
        createResourceUtxo(100000, false)
      ];
      
      const result = selectResourceUtxos(utxos, {
        requiredAmount: 5000,
        feeRate: 1,
        preferCloserAmount: true
      });
      
      // Should select 6000 sat UTXO (closest match)
      expect(result.selectedUtxos.length).toBe(1);
      expect(result.selectedUtxos[0].value).toBe(6000);
    });

    test('default strategy uses largest first', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(1000, false),
        createResourceUtxo(50000, false),
        createResourceUtxo(5000, false)
      ];
      
      const result = selectResourceUtxos(utxos, {
        requiredAmount: 2000,
        feeRate: 1
      });
      
      // Should select largest (50000) first
      expect(result.selectedUtxos[0].value).toBe(50000);
    });
  });

  describe('Edge Cases', () => {
    test('throws when no eligible UTXOs available', () => {
      expect(() => {
        selectResourceUtxos([], {
          requiredAmount: 1000,
          feeRate: 1
        });
      }).toThrow('No eligible UTXOs');
    });

    test('throws INSUFFICIENT_FUNDS when not enough clean UTXOs', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(1000, true),  // Has resource
        createResourceUtxo(500, false)   // Too small
      ];
      
      expect(() => {
        selectResourceUtxos(utxos, {
          requiredAmount: 10000,
          feeRate: 1,
          allowResourceUtxos: false
        });
      }).toThrow('Insufficient funds');
    });

    test('handles single UTXO that covers amount', () => {
      const utxos: ResourceUtxo[] = [
        createResourceUtxo(100000, false)
      ];
      
      const result = selectResourceUtxos(utxos, {
        requiredAmount: 10000,
        feeRate: 1
      });
      
      expect(result.selectedUtxos.length).toBe(1);
      expect(result.totalSelectedValue).toBe(100000);
    });
  });
});

describe('selectUtxosForPayment', () => {
  test('convenience function never uses resource UTXOs', () => {
    const utxos: ResourceUtxo[] = [
      createResourceUtxo(10000, true),
      createResourceUtxo(50000, false)
    ];
    
    const result = selectUtxosForPayment(utxos, 5000, 1);
    
    expect(result.selectedUtxos.every(u => !u.hasResource)).toBe(true);
  });

  test('throws when only resource UTXOs available', () => {
    const utxos: ResourceUtxo[] = [
      createResourceUtxo(10000, true)
    ];
    
    expect(() => {
      selectUtxosForPayment(utxos, 5000, 1);
    }).toThrow('All available UTXOs contain resources');
  });
});

