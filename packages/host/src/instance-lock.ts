/**
 * Single-instance enforcement for the data directory.
 *
 * The spend guards and file stores coordinate inside one process. Hold a
 * SQLite exclusive transaction for that process's entire lifetime so another
 * writer cannot enter, even if the holder is paused. The operating system
 * releases the lock when a process dies; elapsed time never transfers ownership.
 * The database path must remain in place, including between acquisitions.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILENAME = '.instance.lock.sqlite';

export interface InstanceLock {
  path: string;
  /** Release the exclusive transaction and close its connection. Idempotent. */
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
    `  Run ONE replica and stop the current writer before starting its replacement.\n` +
    `  A paused process retains ownership; a terminated process releases it automatically.\n` +
    `  Never delete ${path}: replacing a live lock file would allow a second writer.`
  );
}

/** Claim the data directory or fail closed when another writer holds it. */
export async function acquireInstanceLock(
  dataDir: string
): Promise<InstanceLock> {
  const path = join(dataDir, LOCK_FILENAME);
  mkdirSync(dataDir, { recursive: true });
  let database: Database | undefined;
  try {
    database = new Database(path, { create: true });
    database.exec('PRAGMA busy_timeout = 0');
    // WAL allows readers alongside its writer and is unsuitable for this lock.
    database.exec('PRAGMA journal_mode = DELETE');
    database.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    database?.close();
    const code = (error as { code?: string })?.code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      throw new MultipleInstanceError(refusalMessage(dataDir, path));
    }
    throw error;
  }

  // Keep the connection strongly reachable until release. There is deliberately
  // no timeout, heartbeat, stale-file cleanup or unlink on this ownership path.
  const connection = database;
  let released = false;
  return {
    path,
    async release() {
      if (released) return;
      released = true;
      try {
        connection.exec('ROLLBACK');
      } finally {
        connection.close();
      }
    },
  };
}

/** Release on graceful termination; OS file locks also cover SIGKILL/crashes. */
export function releaseOnExit(lock: InstanceLock): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      void lock.release().finally(() => process.exit(0));
    });
  }
}
