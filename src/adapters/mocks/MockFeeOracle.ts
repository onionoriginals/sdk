import type { FeeOracleAdapter } from '../types';

export class MockFeeOracle implements FeeOracleAdapter {
  constructor(private readonly defaultRate: number = 10) {}
  async estimateFeeRate(targetBlocks: number = 1): Promise<number> {
    const multiplier = Math.max(1, Math.min(6, targetBlocks));
    return this.defaultRate * multiplier;
  }
}

