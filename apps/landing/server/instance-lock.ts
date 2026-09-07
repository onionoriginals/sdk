/**
 * Single-instance enforcement for the data directory.
 *
 * Everything on the money path assumes one process. The double-spend guard is
 * an in-process promise chain, the rate limiters are in-memory Maps, and the
 * file stores serialize through the event loop. Two replicas sharing a volume
 * could therefore spend the same funding outpoint and strand a creator's BTC.
 *
 * The lock implementation deliberately lives in a maintained lock library.
 * Its acquisition uses atomic mkdir, and stale recovery atomically renames the
 * stale directory to a unique claim before removing it. Keeping that protocol
 * in one tested primitive avoids check-then-write and check-then-unlink races
 * between a displaced holder and its successor.
 */
import lockfile from '@bybrave/proper-lockfile2';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILENAME = '.instance.lock';
export const HEARTBEAT_MS = 10_000;
export const STALE_AFTER_MS = 60_000;

export interface InstanceLock {
  path: string;
  /** Stop heartbeating and release the lock. Idempotent. */
  release(): Promise<void>;
}

export class MultipleInstanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultipleInstanceError';
  }
}

function refusalMessage(dataDir: string, path: string): string {
  return (
    `[landing] Refusing to start: another process is already writing to ${dataDir}.\n` +
    `  This service is single-instance by construction. The double-spend guard, every rate limiter and both\n` +
    `  file stores coordinate through in-process state, so a second writer can build a second commit against\n` +
    `  a funding outpoint the first already spent — stranding a creator's committed BTC on a reveal that can\n` +
    `  never land.\n` +
    `  If you scaled this service up, scale it back to ONE replica.\n` +
    `  A crashed holder is reclaimed ${STALE_AFTER_MS / 1000}s after its last heartbeat. Once you are certain\n` +
    `  no writer is running, you can also remove ${path} before restarting.`
  );
}

/** Claim the data directory or fail closed when another writer holds it. */
export async function acquireInstanceLock(
  dataDir: string,
  opts: {
    log?: (message: string) => void;
    /** Fatal handler for a process whose lock can no longer be guaranteed. */
    onOwnershipLost?: (message: string) => void;
  } = {}
): Promise<InstanceLock> {
  const log = opts.log ?? ((message: string) => console.warn(message));
  const path = join(dataDir, LOCK_FILENAME);
  mkdirSync(dataDir, { recursive: true });

  let reclaimed = false;
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await lockfile.lock(dataDir, {
      lockfilePath: path,
      realpath: false,
      stale: STALE_AFTER_MS,
      update: HEARTBEAT_MS,
      retries: 0,
      onReclaimed: () => {
        reclaimed = true;
      },
      onCompromised: (error) => {
        const message = `[landing] instance-lock ownership lost at ${path}; refusing to continue as a second writer: ${error.message}`;
        if (opts.onOwnershipLost) opts.onOwnershipLost(message);
        else {
          console.error(message);
          process.exit(1);
        }
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ELOCKED') {
      throw new MultipleInstanceError(refusalMessage(dataDir, path));
    }
    throw error;
  }

  if (reclaimed) log(`[landing] reclaimed an abandoned instance lock at ${path}.`);

  let released = false;
  return {
    path,
    async release() {
      if (released) return;
      released = true;
      await releaseLock();
    },
  };
}

/** Release cleanly on termination signals; the lock library also covers exit. */
export function releaseOnExit(lock: InstanceLock): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      void lock.release().finally(() => process.exit(0));
    });
  }
}
