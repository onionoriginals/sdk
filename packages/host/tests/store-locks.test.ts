import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '@originals/sdk/originals/fs';
import { acquireInstanceLock } from '../src/instance-lock.js';
import { breakForeignStoreLocks } from '../src/store-locks.js';

const FOREIGN = JSON.stringify({ pid: 18, host: '42eee9bb9202', token: 'old', start: '1' });

async function storeRoot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'store-locks-'));
  const root = join(dataDir, 'originals-anchoring', 'sub-1', 'a'.repeat(64), 'store');
  await mkdir(root, { recursive: true });
  return { dataDir, root, lock: await acquireInstanceLock(dataDir) };
}

describe('breakForeignStoreLocks', () => {
  test("another host's lock refuses the store until broken", async () => {
    const { dataDir, root, lock } = await storeRoot();
    try {
      await writeFile(join(root, '.lock'), FOREIGN);
      await expect(FileStore.open(root)).rejects.toMatchObject({ code: 'STORE_LOCKED' });
      expect(await breakForeignStoreLocks(lock, dataDir)).toEqual([{ path: join(root, '.lock'), pid: 18, host: '42eee9bb9202' }]);
      await (await FileStore.open(root)).close();
    } finally { await lock.release(); }
  });

  test("leaves this host's live lock, unreadable records, and other files alone", async () => {
    const { dataDir, root, lock } = await storeRoot();
    const store = await FileStore.open(root);
    try {
      const live = await readFile(join(root, '.lock'), 'utf8');
      await writeFile(join(dataDir, '.lock'), '18');
      await writeFile(join(root, 'entries.jsonl'), FOREIGN);
      expect(await breakForeignStoreLocks(lock, dataDir, hostname())).toEqual([]);
      expect(await readFile(join(root, '.lock'), 'utf8')).toBe(live);
    } finally { await store.close(); await lock.release(); }
  });

  test('a stranded break claim from another host goes too', async () => {
    const { dataDir, root, lock } = await storeRoot();
    try {
      await writeFile(join(root, '.lock.break.0123456789abcdef0123456789abcdef'), FOREIGN);
      expect(await breakForeignStoreLocks(lock, dataDir)).toHaveLength(1);
    } finally { await lock.release(); }
  });
});
