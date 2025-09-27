import { withRetry as retry } from '../../src/utils/retry';

describe('utils/retry', () => {
  jest.setTimeout(10000);

  test('succeeds immediately without retries', async () => {
    const op = jest.fn(async () => 42);
    const result = await retry(op, { maxRetries: 3, baseDelayMs: 1, jitterFactor: 0 });
    expect(result).toBe(42);
    expect(op).toHaveBeenCalledTimes(1);
  });

  test('succeeds with completely default options (no second arg)', async () => {
    const op = jest.fn(async () => 5);
    const result = await retry(op);
    expect(result).toBe(5);
    expect(op).toHaveBeenCalledTimes(1);
  });

  test('retries on failure then succeeds', async () => {
    let calls = 0;
    const op = jest.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    });
    const result = await retry(op, { maxRetries: 5, baseDelayMs: 1, backoffFactor: 2, jitterFactor: 0 });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  test('honors isRetriable false to stop early', async () => {
    const op = jest.fn(async () => { throw new Error('fail'); });
    await expect(retry(op, { maxRetries: 5, baseDelayMs: 1, jitterFactor: 0, isRetriable: () => false }))
      .rejects.toThrow('fail');
    expect(op).toHaveBeenCalledTimes(1);
  });

  test('exhausts retries and throws last error', async () => {
    const op = jest.fn(async () => { throw new Error('always'); });
    try {
      await retry(op, { maxRetries: 2, baseDelayMs: 1, backoffFactor: 3, maxDelayMs: 5, jitterFactor: 0 });
      fail('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe('always');
    }
    expect(op).toHaveBeenCalledTimes(3);
  });

  test('respects jitter option true/false without throwing', async () => {
    // Case 1: jitter=true and no retry needed
    const opNoRetry = jest.fn(async () => 7);
    await expect(retry(opNoRetry, { jitterFactor: 0.5 })).resolves.toBe(7);
    // Case 2: jitter=false and no retry needed
    const opNoRetry2 = jest.fn(async () => 7);
    await expect(retry(opNoRetry2, { jitterFactor: 0 })).resolves.toBe(7);

    // Case 3: jitter=true with at least one retry to exercise addJitter path
    let attempts = 0;
    const opRetry = jest.fn(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
      return 9;
    });
    const result = await retry(opRetry, { maxRetries: 2, baseDelayMs: 1, jitterFactor: 0.5, isRetriable: () => true });
    expect(result).toBe(9);
    expect(opRetry).toHaveBeenCalledTimes(2);

    // Case 4: jitter=false with a retry to hit non-jitter sleep path
    let tries = 0;
    const opRetryNoJitter = jest.fn(async () => {
      tries += 1;
      if (tries < 2) throw new Error('once');
      return 10;
    });
    const resultNoJitter = await retry(opRetryNoJitter, { maxRetries: 2, baseDelayMs: 1, jitterFactor: 0 });
    expect(resultNoJitter).toBe(10);
    expect(opRetryNoJitter).toHaveBeenCalledTimes(2);
  });

  test('defaults jitterFactor>0 when unspecified and performs retry', async () => {
    let n = 0;
    const op = jest.fn(async () => {
      n += 1;
      if (n < 2) throw new Error('once');
      return 'done';
    });
    const res = await retry(op, { maxRetries: 1, baseDelayMs: 1 });
    expect(res).toBe('done');
    expect(op).toHaveBeenCalledTimes(2);
  });

  test('skips loop when maxRetries < 0 and rejects immediately', async () => {
    const op = jest.fn(async () => 1);
    await expect(retry(op, { maxRetries: -1 })).rejects.toBeUndefined();
    // operation never called because loop condition fails
    expect(op).not.toHaveBeenCalled();
  });
});

