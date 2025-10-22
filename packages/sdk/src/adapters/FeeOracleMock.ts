import { FeeOracleAdapter } from './types';

export class FeeOracleMock implements FeeOracleAdapter {
  constructor(private feeRate = 7) {}
  async estimateFeeRate(targetBlocks = 1): Promise<number> {
    return Math.max(1, this.feeRate - (targetBlocks - 1));
  }
}

