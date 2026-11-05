/**
 * Break FileStore locks left on a shared data volume by an earlier container.
 *
 * The SDK's FileStore writes `<root>/.lock` naming the holder's pid and
 * hostname, and refuses to break a lock from another host ("another host's
 * pid cannot be checked"). On a platform that gives every deploy a new
 * container hostname over the same volume (Railway), a process stopped while
 * a store was open — SIGKILL, a crash, or a host before `close()` existed —
 * strands that store: every later open fails with STORE_LOCKED until the file
 * is removed by hand.
 *
 * Holding the instance lock is what makes breaking them safe: it proves no
 * other live process writes this data directory, so a store lock recorded by
 * any other host belongs to a process that is gone. The `lock` parameter is
 * there to make the caller show it holds one. A lock from THIS host, or a
 * record that cannot be read, is left alone; the SDK judges those itself.
 */
import { hostname } from 'node:os';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstanceLock } from './instance-lock.js';

export interface BrokenStoreLock {
  path: string;
  pid: number;
  host: string;
}

/** `originals-anchoring/<sub>/<key>/store/.lock` is 4 levels down; a little room for other layouts. */
const MAX_DEPTH = 6;

const isLockFile = (name: string) => name === '.lock' || name.startsWith('.lock.break.');

function lockRecord(text: string): { pid: number; host: string } | null {
  try {
    const record = JSON.parse(text.trim()) as { pid?: unknown; host?: unknown; token?: unknown };
    if (typeof record.pid !== 'number' || typeof record.host !== 'string' || typeof record.token !== 'string') return null;
    return { pid: record.pid, host: record.host };
  } catch {
    return null;
  }
}

/** Remove every FileStore lock under `dataDir` recorded by another host. Call only while holding `lock`. */
export async function breakForeignStoreLocks(
  _lock: InstanceLock,
  dataDir: string,
  here: string = hostname(),
): Promise<BrokenStoreLock[]> {
  const removed: BrokenStoreLock[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isLockFile(entry.name)) continue;
      const text = await readFile(path, 'utf8').catch(() => null);
      const record = text === null ? null : lockRecord(text);
      if (!record || record.host === here) continue;
      await rm(path, { force: true });
      removed.push({ path, ...record });
    }
  };
  await walk(dataDir, 0);
  return removed;
}
