import { retry, RetryError } from '../../src/utils/retry';

describe('utils/retry', () => {
  jest.setTimeout(10000);

  test('succeeds immediately without retries', async () => {
    const op = jest.fn(async () => 42);
    const result = await retry(op, { retries: 3, initialDelayMs: 1, jitter: false });
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
    const result = await retry(op, { retries: 5, initialDelayMs: 1, backoffFactor: 2, jitter: false });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  test('honors shouldRetry false to stop early', async () => {
    const op = jest.fn(async () => { throw new Error('fail'); });
    await expect(retry(op, { retries: 5, initialDelayMs: 1, jitter: false, shouldRetry: () => false }))
      .rejects.toThrow(RetryError);
    expect(op).toHaveBeenCalledTimes(1);
  });

  test('exhausts retries and throws RetryError with attempts', async () => {
    const op = jest.fn(async () => { throw new Error('always'); });
    try {
      await retry(op, { retries: 2, initialDelayMs: 1, backoffFactor: 3, maxDelayMs: 5, jitter: false });
      fail('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(RetryError);
      expect(e.name).toBe('RetryError');
      // attempts is retries+1 executions
      expect(e.attempts).toBe(3);
      expect(e.cause).toBeInstanceOf(Error);
      expect((e.cause as Error).message).toBe('always');
    }
    expect(op).toHaveBeenCalledTimes(3);
  });

  test('respects jitter option true/false without throwing', async () => {
    // Case 1: jitter=true and no retry needed
    const opNoRetry = jest.fn(async () => 7);
    await expect(retry(opNoRetry, { jitter: true })).resolves.toBe(7);
    // Case 2: jitter=false and no retry needed
    const opNoRetry2 = jest.fn(async () => 7);
    await expect(retry(opNoRetry2, { jitter: false })).resolves.toBe(7);

    // Case 3: jitter=true with at least one retry to exercise addJitter path
    let attempts = 0;
    const opRetry = jest.fn(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
      return 9;
    });
    const result = await retry(opRetry, { retries: 2, initialDelayMs: 1, jitter: true, shouldRetry: () => true });
    expect(result).toBe(9);
    expect(opRetry).toHaveBeenCalledTimes(2);

    // Case 4: jitter=false with a retry to hit non-jitter sleep path
    let tries = 0;
    const opRetryNoJitter = jest.fn(async () => {
      tries += 1;
      if (tries < 2) throw new Error('once');
      return 10;
    });
    const resultNoJitter = await retry(opRetryNoJitter, { retries: 2, initialDelayMs: 1, jitter: false });
    expect(resultNoJitter).toBe(10);
    expect(opRetryNoJitter).toHaveBeenCalledTimes(2);
  });

  test('defaults jitter=true when unspecified and performs retry', async () => {
    let n = 0;
    const op = jest.fn(async () => {
      n += 1;
      if (n < 2) throw new Error('once');
      return 'done';
    });
    const res = await retry(op, { retries: 1, initialDelayMs: 1 });
    expect(res).toBe('done');
    expect(op).toHaveBeenCalledTimes(2);
  });

  test('skips loop when retries < 0 and throws RetryError immediately', async () => {
    const op = jest.fn(async () => 1);
    await expect(retry(op, { retries: -1 })).rejects.toBeInstanceOf(RetryError);
    // operation never called because loop condition fails
    expect(op).not.toHaveBeenCalled();
  });
});

