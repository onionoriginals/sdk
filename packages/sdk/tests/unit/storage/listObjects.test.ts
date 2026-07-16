/**
 * Native prefix enumeration on the shipped concrete adapters.
 *
 * `listObjects(domain, prefix)` is now an OPTIONAL member of the public
 * StorageAdapter interface (issue #329): both shipped backends are fully
 * enumerable, and exposing that lets MigrationStorage discover persisted keys
 * natively instead of maintaining a shared mutable index object (the source of
 * the cross-process audit-index race). Making it a documented, optional
 * interface member — rather than a hidden concrete-only capability — lets
 * third-party adapter authors discover and implement the race-free hook.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { LocalStorageAdapter } from '../../../src/storage/LocalStorageAdapter';
import type { StorageAdapter } from '../../../src/storage/StorageAdapter';

describe('StorageAdapter.listObjects (optional interface member, #329)', () => {
  beforeEach(() => {
    MemoryStorageAdapter.clear();
  });

  test('is reachable through the StorageAdapter interface type', async () => {
    // Typing the adapter as the public interface (not the concrete class)
    // and calling listObjects through it is the regression guard: before
    // #329, listObjects was not on the interface, so this reference would
    // not typecheck. A third-party adapter author following the interface
    // can now discover and implement the enumeration hook.
    const adapter: StorageAdapter = new MemoryStorageAdapter();
    await adapter.putObject('iface-mem.example', 'audit/migrations/m1/a.json', '1');
    expect(typeof adapter.listObjects).toBe('function');
    const listed = await adapter.listObjects!('iface-mem.example', 'audit/migrations/');
    expect(listed).toEqual(['audit/migrations/m1/a.json']);
  });
});

describe('MemoryStorageAdapter.listObjects', () => {
  beforeEach(() => {
    MemoryStorageAdapter.clear();
  });

  test('returns stored paths under a prefix, and only those', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putObject('list-mem.example', 'audit/migrations/m1/a.json', '1');
    await adapter.putObject('list-mem.example', 'audit/migrations/m2/b.json', '2');
    await adapter.putObject('list-mem.example', 'checkpoints/c1.json', '3');

    const listed = await adapter.listObjects('list-mem.example', 'audit/migrations/');
    expect(listed.sort()).toEqual(['audit/migrations/m1/a.json', 'audit/migrations/m2/b.json']);
  });

  test('listed paths round-trip through getObject', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putObject('list-mem-rt.example', 'audit/migrations/m1/a.json', 'payload');
    const [key] = await adapter.listObjects('list-mem-rt.example', 'audit/migrations/');
    const result = await adapter.getObject('list-mem-rt.example', key);
    expect(result).not.toBeNull();
    expect(Buffer.from(result!.content).toString('utf8')).toBe('payload');
  });

  test('is domain-isolated', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putObject('list-dom-a.example', 'audit/x.json', 'a');
    await adapter.putObject('list-dom-b.example', 'audit/y.json', 'b');

    expect(await adapter.listObjects('list-dom-a.example', 'audit/')).toEqual(['audit/x.json']);
    expect(await adapter.listObjects('list-dom-b.example', 'audit/')).toEqual(['audit/y.json']);
    expect(await adapter.listObjects('list-dom-c.example', 'audit/')).toEqual([]);
  });

  test('normalizes leading slashes the same way putObject does', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putObject('list-slash.example', '/audit/z.json', 'z');
    expect(await adapter.listObjects('list-slash.example', '/audit/')).toEqual(['audit/z.json']);
    expect(await adapter.listObjects('list-slash.example', 'audit/')).toEqual(['audit/z.json']);
  });

  test('does not treat a domain containing the delimiter as another domain prefix', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putObject('trick::domain', 'audit/a.json', 'a');
    expect(await adapter.listObjects('trick', 'audit/')).toEqual([]);
    expect(await adapter.listObjects('trick::domain', 'audit/')).toEqual(['audit/a.json']);
  });
});

describe('LocalStorageAdapter.listObjects', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'originals-list-'));
  });

  test('returns stored paths under a prefix, recursively, and only those', async () => {
    try {
      const adapter = new LocalStorageAdapter({ baseDir: dir });
      await adapter.putObject('example.com', 'audit/migrations/m1/a.json', '1');
      await adapter.putObject('example.com', 'audit/migrations/m2/nested/b.json', '2');
      await adapter.putObject('example.com', 'checkpoints/c1.json', '3');

      const listed = await adapter.listObjects('example.com', 'audit/migrations/');
      expect(listed.sort()).toEqual([
        'audit/migrations/m1/a.json',
        'audit/migrations/m2/nested/b.json'
      ]);

      // Listed paths round-trip through getObject.
      const result = await adapter.getObject('example.com', listed.sort()[0]);
      expect(result).not.toBeNull();
      expect(Buffer.from(result!.content).toString('utf8')).toBe('1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is domain-isolated and returns [] for unknown domains', async () => {
    try {
      const adapter = new LocalStorageAdapter({ baseDir: dir });
      await adapter.putObject('a.example', 'audit/x.json', 'a');
      await adapter.putObject('b.example', 'audit/y.json', 'b');

      expect(await adapter.listObjects('a.example', 'audit/')).toEqual(['audit/x.json']);
      expect(await adapter.listObjects('b.example', 'audit/')).toEqual(['audit/y.json']);
      expect(await adapter.listObjects('never-written.example', 'audit/')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
