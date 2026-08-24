/**
 * The single-instance guard.
 *
 * The failure it exists to prevent: two replicas sharing the volume, both
 * seeing the same funding outpoint as unspent, both building a commit against
 * it — and the loser's reveal stranded on a double-spent commit, which is a
 * creator's BTC committed to an inscription that can never land. Everything on
 * the money path coordinates through in-process state, so nothing downstream
 * would notice.
 *
 * Every test drives the real filesystem through a tmp dir, with the clock,
 * pid, hostname and liveness probe injected so the staleness policy is
 * exercised without sleeping.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireInstanceLock,
  isAbandoned,
  MultipleInstanceError,
  LOCK_FILENAME,
  STALE_AFTER_MS,
  type LockEnvironment,
  type LockRecord,
} from '../instance-lock';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'instance-lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A controllable process identity. `alive` is the set of live pids on this host. */
function makeEnv(over: Partial<LockEnvironment> & { alive?: Set<number> } = {}): LockEnvironment {
  const alive = over.alive ?? new Set<number>();
  let seq = 0;
  return {
    now: over.now ?? (() => 1_700_000_000_000),
    pid: over.pid ?? 100,
    host: over.host ?? 'host-a',
    isProcessAlive: over.isProcessAlive ?? ((pid) => alive.has(pid)),
    newOwnerId: over.newOwnerId ?? (() => `owner-${over.pid ?? 100}-${seq++}`),
  };
}

/** No real timers in tests: the heartbeat is scheduled through this. */
const noTimers = {
  setInterval: () => ({ unref: () => {} }),
  clearInterval: () => {},
};

const lockPath = () => join(dir, LOCK_FILENAME);
const readRecord = (): LockRecord => JSON.parse(readFileSync(lockPath(), 'utf8'));

describe('acquiring the lock on a free directory', () => {
  test('writes a record naming this process and returns a releasable handle', () => {
    const lock = acquireInstanceLock(dir, { env: makeEnv(), log: () => {}, ...noTimers });
    const record = readRecord();
    expect(record.pid).toBe(100);
    expect(record.hostname).toBe('host-a');
    expect(record.owner).toBe(lock.record.owner);

    lock.release();
    expect(() => readFileSync(lockPath(), 'utf8')).toThrow();
  });

  test('release is idempotent', () => {
    const lock = acquireInstanceLock(dir, { env: makeEnv(), log: () => {}, ...noTimers });
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });
});

describe('a second live writer is refused', () => {
  test('a fresh lock held by a live process on THIS host blocks the start', () => {
    const first = makeEnv({ pid: 100, alive: new Set([100]) });
    acquireInstanceLock(dir, { env: first, log: () => {}, ...noTimers });

    const second = makeEnv({ pid: 200, alive: new Set([100, 200]) });
    expect(() => acquireInstanceLock(dir, { env: second, log: () => {}, ...noTimers })).toThrow(
      MultipleInstanceError
    );
  });

  test('a fresh lock held by ANOTHER host blocks the start — the replica case', () => {
    // The real scenario: scaling to 2 replicas. We cannot probe that
    // container's processes, so a fresh heartbeat is the whole of the evidence
    // and it must be believed.
    const other: LockRecord = {
      owner: 'replica-1',
      pid: 7,
      hostname: 'railway-replica-1',
      startedAt: new Date(1_700_000_000_000).toISOString(),
      heartbeatAt: new Date(1_700_000_000_000).toISOString(),
    };
    writeFileSync(lockPath(), JSON.stringify(other));

    const env = makeEnv({ host: 'railway-replica-2', pid: 9 });
    let thrown: unknown;
    try {
      acquireInstanceLock(dir, { env, log: () => {}, ...noTimers });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MultipleInstanceError);
    // The message has to tell an operator what to actually do.
    expect((thrown as Error).message).toContain('railway-replica-1');
    expect((thrown as Error).message).toMatch(/numReplicas/);
  });

  test('the refusal leaves the incumbent lock untouched', () => {
    const first = makeEnv({ pid: 100, alive: new Set([100]) });
    const lock = acquireInstanceLock(dir, { env: first, log: () => {}, ...noTimers });

    const second = makeEnv({ pid: 200, alive: new Set([100, 200]) });
    expect(() => acquireInstanceLock(dir, { env: second, log: () => {}, ...noTimers })).toThrow();
    expect(readRecord().owner).toBe(lock.record.owner);
  });
});

describe('an abandoned lock is taken over', () => {
  test('same host, dead pid: taken over immediately, without waiting out staleness', () => {
    // A crashed local dev server must not cost the next start a 60s wait.
    const first = makeEnv({ pid: 100, alive: new Set([100]) });
    acquireInstanceLock(dir, { env: first, log: () => {}, ...noTimers });

    const second = makeEnv({ pid: 200, alive: new Set([200]) }); // 100 is gone
    const lines: string[] = [];
    const lock = acquireInstanceLock(dir, { env: second, log: (m) => lines.push(m), ...noTimers });
    expect(readRecord().owner).toBe(lock.record.owner);
    expect(lines.join('\n')).toContain('abandoned');
  });

  test('different host, heartbeat gone quiet past the window: taken over', () => {
    const t0 = 1_700_000_000_000;
    writeFileSync(
      lockPath(),
      JSON.stringify({
        owner: 'dead-container',
        pid: 7,
        hostname: 'old-container',
        startedAt: new Date(t0).toISOString(),
        heartbeatAt: new Date(t0).toISOString(),
      })
    );
    const env = makeEnv({ host: 'new-container', pid: 9, now: () => t0 + STALE_AFTER_MS + 1 });
    const lock = acquireInstanceLock(dir, { env, log: () => {}, ...noTimers });
    expect(readRecord().owner).toBe(lock.record.owner);
  });

  test('one second inside the window is still held — the boundary is not rounded away', () => {
    const t0 = 1_700_000_000_000;
    writeFileSync(
      lockPath(),
      JSON.stringify({
        owner: 'live-container',
        pid: 7,
        hostname: 'other-container',
        startedAt: new Date(t0).toISOString(),
        heartbeatAt: new Date(t0).toISOString(),
      })
    );
    const env = makeEnv({ host: 'new-container', pid: 9, now: () => t0 + STALE_AFTER_MS - 1000 });
    expect(() => acquireInstanceLock(dir, { env, log: () => {}, ...noTimers })).toThrow(
      MultipleInstanceError
    );
  });

  test('an unreadable lock does not deadlock the service', () => {
    writeFileSync(lockPath(), 'not json at all');
    const lines: string[] = [];
    const lock = acquireInstanceLock(dir, { env: makeEnv(), log: (m) => lines.push(m), ...noTimers });
    expect(readRecord().owner).toBe(lock.record.owner);
    expect(lines.join('\n')).toContain('unreadable');
  });
});

describe('release only removes a lock we still hold', () => {
  test('a process whose lock was taken over does not delete the new holder’s lock', () => {
    // The sequence that would otherwise disarm the guard: A goes quiet, B takes
    // over, then A's shutdown handler finally runs. If A unlinked here, the
    // volume would be left unguarded with B still writing to it.
    const a = makeEnv({ pid: 100, alive: new Set([100]) });
    const lockA = acquireInstanceLock(dir, { env: a, log: () => {}, ...noTimers });

    const b = makeEnv({ pid: 200, alive: new Set([200]) });
    const lockB = acquireInstanceLock(dir, { env: b, log: () => {}, ...noTimers });

    lockA.release();
    expect(readRecord().owner).toBe(lockB.record.owner);
  });
});

describe('isAbandoned', () => {
  const holder = (over: Partial<LockRecord> = {}): LockRecord => ({
    owner: 'o',
    pid: 42,
    hostname: 'host-a',
    startedAt: new Date(0).toISOString(),
    heartbeatAt: new Date(1_700_000_000_000).toISOString(),
    ...over,
  });

  test('a live pid on this host is never abandoned, however old the heartbeat', () => {
    const env = makeEnv({ host: 'host-a', alive: new Set([42]), now: () => 2_000_000_000_000 });
    // Deliberately far past the stale window. A process we can SEE running is
    // running, whatever its heartbeat says — a wedged writer is still a writer,
    // and staleness must not be a way to take the lock out from under it.
    expect(isAbandoned(holder(), env)).toBe(false);
  });

  test('a dead pid on this host is abandoned even with a fresh heartbeat', () => {
    const env = makeEnv({ host: 'host-a', alive: new Set(), now: () => 1_700_000_000_000 });
    expect(isAbandoned(holder(), env)).toBe(true);
  });

  test('on another host only the heartbeat can settle it', () => {
    const t0 = 1_700_000_000_000;
    const env = (now: number) => makeEnv({ host: 'elsewhere', alive: new Set([42]), now: () => now });
    expect(isAbandoned(holder(), env(t0 + STALE_AFTER_MS - 1))).toBe(false);
    expect(isAbandoned(holder(), env(t0 + STALE_AFTER_MS + 1))).toBe(true);
  });

  test('an unparseable heartbeat counts as abandoned rather than locking us out forever', () => {
    const env = makeEnv({ host: 'other', alive: new Set([42]) });
    expect(isAbandoned(holder({ heartbeatAt: 'nonsense' }), env)).toBe(true);
  });
});
