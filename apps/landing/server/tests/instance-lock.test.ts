/** Integration coverage for the process-owned single-writer lock. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock, LOCK_FILENAME, MultipleInstanceError } from '../instance-lock';

let dir: string;
const children: ReturnType<typeof Bun.spawn>[] = [];
const modulePath = new URL('../instance-lock.ts', import.meta.url).pathname;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'instance-lock-'));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
    await child.exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function startHolder() {
  const child = Bun.spawn([process.execPath, '-e', `
    import { acquireInstanceLock, releaseOnExit } from ${JSON.stringify(modulePath)};
    const lock = await acquireInstanceLock(${JSON.stringify(dir)});
    releaseOnExit(lock);
    console.log('LOCKED');
    process.stdin.resume();
  `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  children.push(child);
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(first.value)).toContain('LOCKED');
  return child;
}

describe('instance lock', () => {
  test('acquires exclusively and releases idempotently without deleting the database', async () => {
    const first = await acquireInstanceLock(dir);
    expect(first.path).toBe(join(dir, LOCK_FILENAME));
    await expect(acquireInstanceLock(dir)).rejects.toBeInstanceOf(MultipleInstanceError);
    await first.release();
    await expect(first.release()).resolves.toBeUndefined();
    expect(existsSync(first.path)).toBe(true);
    const next = await acquireInstanceLock(dir);
    // Releasing a former owner must never disturb its successor.
    await first.release();
    await expect(acquireInstanceLock(dir)).rejects.toBeInstanceOf(MultipleInstanceError);
    await next.release();
  });

  test('a separate live process prevents acquisition and gives an operational refusal', async () => {
    await startHolder();
    await expect(acquireInstanceLock(dir)).rejects.toBeInstanceOf(MultipleInstanceError);
    await expect(acquireInstanceLock(dir)).rejects.toThrow('ONE replica');
    await expect(acquireInstanceLock(dir)).rejects.toThrow('Never delete');
  });

  test('a killed process releases ownership immediately without stale-file removal', async () => {
    const child = await startHolder();
    child.kill('SIGKILL');
    await child.exited;
    expect(existsSync(join(dir, LOCK_FILENAME))).toBe(true);
    const successor = await acquireInstanceLock(dir);
    await successor.release();
  });

  test('graceful shutdown releases ownership without deleting the database', async () => {
    const child = await startHolder();
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    expect(existsSync(join(dir, LOCK_FILENAME))).toBe(true);
    const successor = await acquireInstanceLock(dir);
    await successor.release();
  });

  test.skipIf(process.platform === 'win32')('a paused holder cannot be displaced by an aged lock file', async () => {
    const child = await startHolder();
    child.kill('SIGSTOP');
    try {
      const old = new Date(0);
      utimesSync(join(dir, LOCK_FILENAME), old, old);
      await expect(acquireInstanceLock(dir)).rejects.toBeInstanceOf(MultipleInstanceError);
    } finally {
      child.kill('SIGCONT');
    }
    await expect(acquireInstanceLock(dir)).rejects.toBeInstanceOf(MultipleInstanceError);
  });
});
