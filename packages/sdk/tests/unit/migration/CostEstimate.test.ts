/**
 * Tests for CostEstimate interface normalization
 * Verifies estimatedDuration is part of the CostEstimate type
 */
import { describe, it, expect } from 'bun:test';
import type { CostEstimate } from '../../../src/migration/types';

describe('CostEstimate interface', () => {
  it('should accept CostEstimate without estimatedDuration', () => {
    const cost: CostEstimate = {
      storageCost: 100,
      networkFees: 50,
      totalCost: 150,
      currency: 'sats',
    };
    expect(cost.storageCost).toBe(100);
    expect(cost.networkFees).toBe(50);
    expect(cost.totalCost).toBe(150);
    expect(cost.currency).toBe('sats');
    expect(cost.estimatedDuration).toBeUndefined();
  });

  it('should accept CostEstimate with estimatedDuration', () => {
    const cost: CostEstimate = {
      storageCost: 100,
      networkFees: 50,
      totalCost: 150,
      currency: 'sats',
      estimatedDuration: 5000,
    };
    expect(cost.estimatedDuration).toBe(5000);
  });

  it('should support runtime objects that include estimatedDuration', () => {
    // This mirrors what MigrationManager produces at runtime
    const runtimeCost: CostEstimate = {
      storageCost: 0,
      networkFees: 0,
      totalCost: 0,
      estimatedDuration: 0,
      currency: 'sats',
    };
    expect(runtimeCost).toEqual({
      storageCost: 0,
      networkFees: 0,
      totalCost: 0,
      estimatedDuration: 0,
      currency: 'sats',
    });
  });
});
