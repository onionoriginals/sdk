import { describe, test, expect } from 'bun:test';
import { FeeOracleMock } from '../../../src/adapters/FeeOracleMock';

describe('FeeOracleMock', () => {
  test('constructor initializes with default fee rate', async () => {
    const oracle = new FeeOracleMock();
    const rate = await oracle.estimateFeeRate();
    expect(rate).toBe(7);
  });

  test('constructor accepts custom fee rate', async () => {
    const oracle = new FeeOracleMock(10);
    const rate = await oracle.estimateFeeRate();
    expect(rate).toBe(10);
  });

  test('estimateFeeRate returns rate for 1 block', async () => {
    const oracle = new FeeOracleMock(7);
    const rate = await oracle.estimateFeeRate(1);
    expect(rate).toBe(7);
  });

  test('estimateFeeRate decreases for higher target blocks', async () => {
    const oracle = new FeeOracleMock(7);
    const rate = await oracle.estimateFeeRate(3);
    expect(rate).toBe(5); // 7 - (3 - 1) = 5
  });

  test('estimateFeeRate returns minimum of 1', async () => {
    const oracle = new FeeOracleMock(2);
    const rate = await oracle.estimateFeeRate(10);
    expect(rate).toBe(1); // Math.max(1, 2 - 9) = 1
  });

  test('estimateFeeRate works without target blocks parameter', async () => {
    const oracle = new FeeOracleMock(5);
    const rate = await oracle.estimateFeeRate();
    expect(rate).toBe(5);
  });
});
