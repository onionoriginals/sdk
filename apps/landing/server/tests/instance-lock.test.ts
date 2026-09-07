/** Integration coverage for the single-writer filesystem lock. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireInstanceLock,
  LOCK_FILENAME,
  MultipleInstanceError,
  STALE_AFTER_MS,
} from '../instance-lock';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'instance-lock-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lockPath = () => join(dir, LOCK_FILENAME);

describe('instance lock', () => {
  test('acquires exclusively and releases idempotently', async () => {
    const first = await acquireInstanceLock(dir);
    expect(existsSync(lockPath())).toBe(true);

    await expect(acquireInstanceLock(dir)).rejects.toBeInstanceOf(MultipleInstanceError);
    expect(existsSync(lockPath())).toBe(true);

    await first.release();
    await expect(first.release()).resolves.toBeUndefined();
    expect(existsSync(lockPath())).toBe(false);

    const next = await acquireInstanceLock(dir);
    await next.release();
  });

  test('refusal explains the operational fix', async () => {
    const first = await acquireInstanceLock(dir);

    try {
      await acquireInstanceLock(dir);
      throw new Error('second acquisition unexpectedly succeeded');
    } catch (error) {
      expect(error).toBeInstanceOf(MultipleInstanceError);
      expect((error as Error).message).toContain('ONE replica');
      expect((error as Error).message).toContain('60s');
    } finally {
      await first.release();
    }
  });

  test('reclaims a stale lock and reports recovery', async () => {
    mkdirSync(lockPath());
    const stale = new Date(Date.now() - STALE_AFTER_MS - 1_000);
    utimesSync(lockPath(), stale, stale);
    const lines: string[] = [];

    const lock = await acquireInstanceLock(dir, { log: (message) => lines.push(message) });

    expect(lines.join('\n')).toContain('reclaimed an abandoned instance lock');
    await lock.release();
  });

  test('only one concurrent contender can reclaim the same stale lock', async () => {
    mkdirSync(lockPath());
    const stale = new Date(Date.now() - STALE_AFTER_MS - 1_000);
    utimesSync(lockPath(), stale, stale);

    const attempts = await Promise.allSettled([
      acquireInstanceLock(dir),
      acquireInstanceLock(dir),
      acquireInstanceLock(dir),
    ]);
    const winners = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireInstanceLock>>> =>
        attempt.status === 'fulfilled'
    );
    const losers = attempts.filter((attempt) => attempt.status === 'rejected');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
    expect(losers.every((attempt) => attempt.reason instanceof MultipleInstanceError)).toBe(true);
    await winners[0]!.value.release();
  });

  test('an orphaned unique reclaim path never blocks acquisition', async () => {
    mkdirSync(`${lockPath()}.reclaim-dead-process`);

    const lock = await acquireInstanceLock(dir);

    expect(existsSync(lockPath())).toBe(true);
    await lock.release();
  });
});
