/**
 * Single-instance enforcement for the data directory.
 *
 * Everything on the money path assumes one process. The double-spend guard is
 * an in-process promise chain keyed by JWT sub (`subLocks` in bitcoin.ts), every
 * rate limiter is an in-memory Map, the deposit sweep walks a process-local
 * cursor, and both file stores serialize their read-modify-write with nothing
 * but the single-threaded event loop. Each of those is correct — and documented
 * as such — for exactly one writer.
 *
 * Two writers is not a degraded version of that. Two replicas polling the same
 * user's inscription both see the same funding outpoint as unspent, both build
 * a commit against it, and the loser's reveal is stranded on a double-spent
 * commit: a creator's BTC committed to an inscription that can never land. The
 * platform makes that one dashboard click (or one autoscale rule) away, and
 * nothing in the process would notice.
 *
 * So the process asks the volume — the one thing every writer shares — whether
 * anyone else is already writing to it, and refuses to start if so.
 *
 * The mechanism is a heartbeat lock file, with `O_EXCL` create as the atomic
 * primitive. Whether a lock may be TAKEN depends on what we can actually
 * observe (see `isAbandoned`):
 *
 *   - Same host: the PID probe is authoritative in both directions. A dead pid
 *     frees the lock instantly (a crashed dev server costs no wait), and a live
 *     one holds it however stale the heartbeat — a wedged process is still a
 *     writer.
 *   - Another host: we cannot see its processes, so a heartbeat that has gone
 *     quiet longer than STALE_AFTER_MS is the only evidence of death. This is
 *     the container case: a crashed container never releases its lock, and a
 *     restart arrives with a fresh hostname and PID.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const LOCK_FILENAME = '.instance.lock';

/** How often the holder proves it is still alive. */
export const HEARTBEAT_MS = 10_000;
/**
 * How quiet a lock must go before another process may claim it. Six missed
 * heartbeats: long enough that a GC pause, a slow fsync or a busy event loop
 * never looks like death, short enough that a crash-restart is not left
 * waiting minutes for a volume it already owns.
 */
export const STALE_AFTER_MS = 60_000;

export interface LockRecord {
  /** Unique per acquisition — this is what proves WE won a contested write. */
  owner: string;
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface InstanceLock {
  /** The record this process wrote. */
  record: LockRecord;
  path: string;
  /** Stop heartbeating and remove the lock. Idempotent. */
  release(): void;
}

export class MultipleInstanceError extends Error {
  constructor(
    message: string,
    readonly holder: LockRecord
  ) {
    super(message);
    this.name = 'MultipleInstanceError';
  }
}

/** Injectable clock/identity/process seams so the whole policy is testable. */
export interface LockEnvironment {
  now(): number;
  pid: number;
  host: string;
  /** True when a process with this pid exists. Only meaningful on this host. */
  isProcessAlive(pid: number): boolean;
  newOwnerId(): string;
}

export const systemEnvironment: LockEnvironment = {
  now: () => Date.now(),
  pid: process.pid,
  host: hostname(),
  isProcessAlive: (pid) => {
    try {
      // Signal 0 performs the permission/existence check without delivering.
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means it EXISTS but belongs to another user — alive, not absent.
      return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  },
  newOwnerId: () => `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
};

function readLock(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>;
    if (
      typeof parsed?.owner !== 'string' ||
      typeof parsed?.pid !== 'number' ||
      typeof parsed?.hostname !== 'string' ||
      typeof parsed?.heartbeatAt !== 'string'
    ) {
      return null;
    }
    return parsed as LockRecord;
  } catch {
    // Missing, truncated or garbage. A lock we cannot read cannot be honoured;
    // treat it as absent rather than deadlocking the service on a bad byte.
    return null;
  }
}

/**
 * Is `holder` abandoned — safe for us to take over?
 *
 * Same host: a PID probe is authoritative and instant. Different host: we can
 * only wait out the heartbeat, because we cannot see that machine's processes
 * and must assume a live replica until proven otherwise.
 */
export function isAbandoned(holder: LockRecord, env: LockEnvironment): boolean {
  if (holder.hostname === env.host) {
    // We can see this host's processes, so liveness is authoritative in BOTH
    // directions — and staleness must not override it. A process that is
    // running but has stopped heartbeating (wedged event loop, a disk that is
    // failing our heartbeat writes) is still a writer, and taking its lock
    // would create exactly the two-writer condition this guard exists to
    // prevent. Refusing costs availability; taking it costs a creator's BTC.
    //
    // The cost of that choice is PID reuse: after a same-host crash, an
    // unrelated process may inherit the pid and hold this lock indefinitely.
    // That is a wedged deploy with a loud message and a one-line manual
    // remedy (delete the lock file), which is the cheaper failure. On a
    // container platform a restart brings a new hostname anyway, so that path
    // falls to the staleness rule below.
    return !env.isProcessAlive(holder.pid);
  }
  // Another machine: we cannot probe it, so a fresh heartbeat is the whole of
  // the evidence and must be believed until it goes quiet.
  const beat = Date.parse(holder.heartbeatAt);
  const quietFor = Number.isFinite(beat) ? env.now() - beat : Infinity;
  return quietFor > STALE_AFTER_MS;
}

function writeRecord(path: string, record: LockRecord, exclusive: boolean): boolean {
  let fd: number;
  try {
    fd = openSync(path, exclusive ? 'wx' : 'w');
  } catch (err) {
    if (exclusive && (err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
  return true;
}

function describe(holder: LockRecord): string {
  return `pid ${holder.pid} on host ${holder.hostname} (started ${holder.startedAt}, last heartbeat ${holder.heartbeatAt})`;
}

/**
 * Claim the data directory, or throw {@link MultipleInstanceError}.
 *
 * @param setInterval - injected so tests do not leave a live timer behind.
 */
export function acquireInstanceLock(
  dataDir: string,
  opts: {
    env?: LockEnvironment;
    log?: (message: string) => void;
    setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
    clearInterval?: (handle: unknown) => void;
  } = {}
): InstanceLock {
  const env = opts.env ?? systemEnvironment;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const path = join(dataDir, LOCK_FILENAME);

  mkdirSync(dataDir, { recursive: true });

  const stamp = () => new Date(env.now()).toISOString();
  const record: LockRecord = {
    owner: env.newOwnerId(),
    pid: env.pid,
    hostname: env.host,
    startedAt: stamp(),
    heartbeatAt: stamp(),
  };

  if (!writeRecord(path, record, true)) {
    const holder = readLock(path);
    if (holder && !isAbandoned(holder, env)) {
      throw new MultipleInstanceError(
        `[landing] Refusing to start: another process is already writing to ${dataDir} — ${describe(holder)}.\n` +
          `  This service is single-instance by construction. The double-spend guard, every rate limiter and both\n` +
          `  file stores coordinate through in-process state, so a second writer can build a second commit against\n` +
          `  a funding outpoint the first already spent — stranding a creator's committed BTC on a reveal that can\n` +
          `  never land.\n` +
          `  If you scaled this service up, scale it back to ONE replica (railway.json pins numReplicas: 1).\n` +
          `  If that process is genuinely gone, its lock goes stale ${STALE_AFTER_MS / 1000}s after its last\n` +
          `  heartbeat and the next start will take over; you can also delete ${path} by hand once you are sure.`,
        holder
      );
    }
    if (holder) {
      log(
        `[landing] taking over an abandoned instance lock at ${path} — previous holder ${describe(holder)}.`
      );
    } else {
      log(`[landing] replacing an unreadable instance lock at ${path}.`);
    }
    writeRecord(path, record, false);

    // Two processes can both find the lock abandoned and both rewrite it. The
    // exclusive create cannot arbitrate that, so the owner id does: re-read,
    // and whoever is not in the file steps aside. One of them always is.
    const settled = readLock(path);
    if (!settled || settled.owner !== record.owner) {
      throw new MultipleInstanceError(
        `[landing] Refusing to start: lost a race for the instance lock at ${path} — ` +
          `${settled ? describe(settled) : 'another process'} claimed it. This is the correct outcome; ` +
          `only one process may write to ${dataDir}.`,
        settled ?? record
      );
    }
  }

  const schedule = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const cancel = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const timer = schedule(() => {
    record.heartbeatAt = stamp();
    try {
      writeRecord(path, record, false);
    } catch (err) {
      // A failed heartbeat is not worth killing a running service over: the
      // lock simply ages toward stale, and the volume problem behind it will
      // surface far more loudly on the next real write.
      log(`[landing] instance-lock heartbeat failed: ${(err as Error)?.message}`);
    }
  }, HEARTBEAT_MS);
  // Never hold the event loop open for the heartbeat alone.
  timer.unref?.();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    cancel(timer);
    try {
      // Only remove a lock that is still OURS — a takeover after a stale
      // window must not have its lock deleted by the process it replaced.
      if (existsSync(path) && readLock(path)?.owner === record.owner) unlinkSync(path);
    } catch {
      // Best effort: a lock left behind goes stale on its own.
    }
  };

  return { record, path, release };
}

/**
 * Wire `release()` to the ways this process ends, so an orderly shutdown frees
 * the volume immediately instead of making the next start wait out staleness.
 */
export function releaseOnExit(lock: InstanceLock): void {
  const off = () => lock.release();
  process.once('exit', off);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      off();
      process.exit(0);
    });
  }
}
