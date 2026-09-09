import { expect, test } from 'bun:test';
import { until } from './environment';

test('readiness retries transient service failures', async () => {
  let calls = 0;
  await until('recovering service', async () => {
    if (++calls === 1) throw new Error('connection refused during startup');
    return calls === 3;
  }, 1_000);
  expect(calls).toBe(3);
});

test('readiness timeout reports the last service error', async () => {
  const cause = new Error('index is unavailable');
  try {
    await until('ord indexed tip', async () => { throw cause; }, 25);
    throw new Error('Readiness unexpectedly passed');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Timed out waiting for ord indexed tip');
    expect((error as Error).cause).toBe(cause);
  }
});

test('a dead node aborts readiness without masking exit as a timeout', async () => {
  let checked = false;
  await expect(until('dead node', async () => { checked = true; return true; }, 30_000,
    () => { throw new Error('Bitcoin Core exited (73)'); })).rejects.toThrow('Bitcoin Core exited (73)');
  expect(checked).toBe(false);
});
