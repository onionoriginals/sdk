import { FeeOracleAdapter } from './types';

export class FeeOracleMock implements FeeOracleAdapter {
  constructor(private feeRate = 7) {}
  estimateFeeRate(targetBlocks = 1): Promise<number> {
    return Promise.resolve(Math.max(1, this.feeRate - (targetBlocks - 1)));
  }
}

