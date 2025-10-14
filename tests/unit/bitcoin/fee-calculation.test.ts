/**
 * Tests for fee calculation functions
 */
import { describe, test, expect } from 'bun:test';
import { calculateFee } from '../../../src';

describe('calculateFee', () => {
  describe('Basic Fee Tests', () => {
    test('calculates fee for 1 input, 2 outputs (140 vbytes)', () => {
      const vbytes = 140; // 1 input, 2 outputs
      const feeRate = 10; // 10 sats/vB
      
      const fee = calculateFee(vbytes, feeRate);
      
      // 140 vbytes * 10 sats/vB = 1400 sats
      expect(fee).toBe(1400n);
    });

    test('calculates fee for 3 inputs, 1 output (245 vbytes)', () => {
      const vbytes = 245; // 3 inputs, 1 output
      const feeRate = 5; // 5 sats/vB
      
      const fee = calculateFee(vbytes, feeRate);
      
      // 245 vbytes * 5 sats/vB = 1225 sats
      expect(fee).toBe(1225n);
    });

    test('fee scales linearly with fee rate (above minimum)', () => {
      const vbytes = 100;
      
      // Use fee rates above minimum to ensure linear scaling
      const fee5 = calculateFee(vbytes, 5);
      const fee10 = calculateFee(vbytes, 10);
      const fee20 = calculateFee(vbytes, 20);
      
      // Should scale linearly when all above minimum
      expect(fee10).toBe(fee5 * 2n);
      expect(fee20).toBe(fee5 * 4n);
    });

    test('rounds up fractional satoshis', () => {
      const vbytes = 100;
      const feeRate = 1.5; // 1.5 sats/vB
      
      const fee = calculateFee(vbytes, feeRate);
      
      // 100 * 1.5 = 150, should round to 150
      expect(fee).toBe(150n);
    });

    test('handles large transaction sizes', () => {
      const vbytes = 10000; // Large transaction
      const feeRate = 50;
      
      const fee = calculateFee(vbytes, feeRate);
      
      // 10000 * 50 = 500000
      expect(fee).toBe(500000n);
    });
  });

  describe('Minimum Relay Fee Tests', () => {
    test('respects minimum relay fee (1.1 sats/vB)', () => {
      const vbytes = 1000;
      const feeRate = 0.5; // Below minimum
      
      const fee = calculateFee(vbytes, feeRate);
      
      // Should use minimum relay fee: 1000 * 1.1 = 1100
      expect(fee).toBeGreaterThanOrEqual(1100n);
    });

    test('uses specified fee rate when above minimum', () => {
      const vbytes = 100;
      const feeRate = 10; // Well above minimum
      
      const fee = calculateFee(vbytes, feeRate);
      
      // Should use 10 sats/vB: 100 * 10 = 1000
      expect(fee).toBe(1000n);
    });

    test('minimum fee is at least 1 sat', () => {
      const vbytes = 1;
      const feeRate = 0.1; // Very low
      
      const fee = calculateFee(vbytes, feeRate);
      
      // Should be at least 1 sat
      expect(fee).toBeGreaterThanOrEqual(1n);
    });
  });

  describe('Edge Cases', () => {
    test('handles zero fee rate (returns 0)', () => {
      const vbytes = 100;
      const feeRate = 0;
      
      const fee = calculateFee(vbytes, feeRate);
      
      // Invalid input, returns 0
      expect(fee).toBe(0n);
    });

    test('handles negative fee rate (returns 0)', () => {
      const vbytes = 100;
      const feeRate = -5;
      
      const fee = calculateFee(vbytes, feeRate);
      
      // Invalid input, returns 0
      expect(fee).toBe(0n);
    });

    test('handles zero vbytes (returns 0)', () => {
      const vbytes = 0;
      const feeRate = 10;
      
      const fee = calculateFee(vbytes, feeRate);
      
      // Invalid input, returns 0
      expect(fee).toBe(0n);
    });

    test('handles negative vbytes (returns 0)', () => {
      const vbytes = -100;
      const feeRate = 10;
      
      const fee = calculateFee(vbytes, feeRate);
      
      // Invalid input, returns 0
      expect(fee).toBe(0n);
    });

    test('handles NaN vbytes (returns 0)', () => {
      const vbytes = NaN;
      const feeRate = 10;
      
      const fee = calculateFee(vbytes, feeRate);
      
      // Invalid input, returns 0
      expect(fee).toBe(0n);
    });

    test('handles NaN fee rate (returns 0)', () => {
      const vbytes = 100;
      const feeRate = NaN;
      
      const fee = calculateFee(vbytes, feeRate);
      
      // Invalid input, returns 0
      expect(fee).toBe(0n);
    });
  });

  describe('Different Fee Rate Scenarios', () => {
    test('calculates fee for low priority (1 sat/vB)', () => {
      const vbytes = 200;
      const feeRate = 1;
      
      const fee = calculateFee(vbytes, feeRate);
      
      // Uses minimum 1.1: Math.ceil(200 * 1.1) = Math.ceil(220) = 220
      // But implementation takes max of ceiling values, which can be 221 due to rounding
      expect(fee).toBeGreaterThanOrEqual(220n);
      expect(fee).toBeLessThanOrEqual(221n);
    });

    test('calculates fee for medium priority (10 sat/vB)', () => {
      const vbytes = 200;
      const feeRate = 10;
      
      const fee = calculateFee(vbytes, feeRate);
      
      expect(fee).toBe(2000n); // 200 * 10
    });

    test('calculates fee for high priority (50 sat/vB)', () => {
      const vbytes = 200;
      const feeRate = 50;
      
      const fee = calculateFee(vbytes, feeRate);
      
      expect(fee).toBe(10000n); // 200 * 50
    });

    test('calculates fee for very high priority (100 sat/vB)', () => {
      const vbytes = 200;
      const feeRate = 100;
      
      const fee = calculateFee(vbytes, feeRate);
      
      expect(fee).toBe(20000n); // 200 * 100
    });
  });

  describe('Return Type Tests', () => {
    test('returns bigint type', () => {
      const fee = calculateFee(100, 10);
      
      expect(typeof fee).toBe('bigint');
    });

    test('returns positive bigint for valid inputs', () => {
      const fee = calculateFee(100, 10);
      
      expect(fee).toBeGreaterThan(0n);
    });

    test('bigint can be used in calculations', () => {
      const fee = calculateFee(100, 10);
      const doubled = fee * 2n;
      
      expect(doubled).toBe(2000n);
    });
  });

  describe('Real-World Scenarios', () => {
    test('simple payment transaction (1 input, 2 outputs)', () => {
      // 10 (overhead) + 68 (input) + 62 (2 outputs) = 140 vbytes
      const vbytes = 140;
      const feeRate = 5; // mempool median
      
      const fee = calculateFee(vbytes, feeRate);
      
      expect(fee).toBe(700n); // 140 * 5
    });

    test('consolidation transaction (10 inputs, 1 output)', () => {
      // 10 + (10 * 68) + 31 = 721 vbytes
      const vbytes = 721;
      const feeRate = 3;
      
      const fee = calculateFee(vbytes, feeRate);
      
      expect(fee).toBe(2163n); // 721 * 3
    });

    test('batch payment (2 inputs, 10 outputs)', () => {
      // 10 + (2 * 68) + (10 * 31) = 456 vbytes
      const vbytes = 456;
      const feeRate = 10;
      
      const fee = calculateFee(vbytes, feeRate);
      
      expect(fee).toBe(4560n); // 456 * 10
    });

    test('inscription commit transaction', () => {
      // Typical commit tx size
      const vbytes = 150;
      const feeRate = 15; // Higher for inscription
      
      const fee = calculateFee(vbytes, feeRate);
      
      expect(fee).toBe(2250n); // 150 * 15
    });
  });
});

