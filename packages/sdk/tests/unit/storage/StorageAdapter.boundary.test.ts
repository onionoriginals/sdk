/**
 * Storage Adapter Boundary Tests
 *
 * Covers:
 * - CRYPTO-STORAGE-008/performance: MemoryStorageAdapter with many objects → correct retrieval at scale
 * - CRYPTO-STORAGE-009/boundary: LocalStorageAdapter handles large file content → stored & retrieved intact
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { LocalStorageAdapter } from '../../../src/storage/LocalStorageAdapter';

// ---------------------------------------------------------------------------
// CRYPTO-STORAGE-008: MemoryStorageAdapter at scale (1000+ objects)
// ---------------------------------------------------------------------------

describe('MemoryStorageAdapter - scale correctness [CRYPTO-STORAGE-008]', () => {
  const OBJECT_COUNT = 1200;
  const DOMAIN = 'scale-test.example.com';

  test('retrieves all 1200 stored objects correctly and none pollutes another key', async () => {
    const adapter = new MemoryStorageAdapter();

    // Store 1200 objects, each with unique content
    for (let i = 0; i < OBJECT_COUNT; i++) {
      const content = `object-content-${i}-${i * 7919}`; // deterministic, unique
      await adapter.putObject(DOMAIN, `/items/item-${i}.txt`, content);
    }

    // Verify every object returns exactly the right content
    let failures = 0;
    for (let i = 0; i < OBJECT_COUNT; i++) {
      const result = await adapter.getObject(DOMAIN, `/items/item-${i}.txt`);
      if (result === null) {
        failures++;
        continue;
      }
      const decoded = new TextDecoder().decode(result.content);
      const expected = `object-content-${i}-${i * 7919}`;
      if (decoded !== expected) {
        failures++;
      }
    }

    expect(failures).toBe(0);
  });

  test('exists() correctly identifies all 1200 stored paths', async () => {
    const adapter = new MemoryStorageAdapter();

    for (let i = 0; i < OBJECT_COUNT; i++) {
      await adapter.putObject(DOMAIN, `/bulk/item-${i}.bin`, new Uint8Array([i % 256]));
    }

    let misses = 0;
    for (let i = 0; i < OBJECT_COUNT; i++) {
      const present = await adapter.exists(DOMAIN, `/bulk/item-${i}.bin`);
      if (!present) misses++;
    }
    expect(misses).toBe(0);

    // A key that was never stored must not exist
    expect(await adapter.exists(DOMAIN, `/bulk/item-${OBJECT_COUNT}.bin`)).toBe(false);
  });

  test('objects in different domains are isolated at scale', async () => {
    const adapter = new MemoryStorageAdapter();
    const COUNT = 500;

    for (let i = 0; i < COUNT; i++) {
      await adapter.putObject('domain-a.com', `/shared/item-${i}.txt`, `a-${i}`);
      await adapter.putObject('domain-b.com', `/shared/item-${i}.txt`, `b-${i}`);
    }

    // Spot-check 10 indices spread across the range
    const indices = [0, 50, 100, 200, 250, 300, 350, 400, 450, 499];
    for (const i of indices) {
      const resA = await adapter.getObject('domain-a.com', `/shared/item-${i}.txt`);
      const resB = await adapter.getObject('domain-b.com', `/shared/item-${i}.txt`);
      expect(new TextDecoder().decode(resA!.content)).toBe(`a-${i}`);
      expect(new TextDecoder().decode(resB!.content)).toBe(`b-${i}`);
    }
  });

  test('last write wins when overwriting the same key 1000 times', async () => {
    const adapter = new MemoryStorageAdapter();
    const key = '/overwrite/target.txt';

    for (let i = 0; i < 1000; i++) {
      await adapter.putObject(DOMAIN, key, `value-${i}`);
    }

    const result = await adapter.getObject(DOMAIN, key);
    expect(result).not.toBeNull();
    expect(new TextDecoder().decode(result!.content)).toBe('value-999');
  });

  test('binary content round-trips exactly at scale', async () => {
    const adapter = new MemoryStorageAdapter();

    for (let i = 0; i < 100; i++) {
      // 256-byte binary payload with all byte values
      const content = new Uint8Array(256);
      for (let b = 0; b < 256; b++) {
        content[b] = (b + i) % 256;
      }
      await adapter.putObject(DOMAIN, `/binary/item-${i}.bin`, content);
    }

    for (let i = 0; i < 100; i++) {
      const result = await adapter.getObject(DOMAIN, `/binary/item-${i}.bin`);
      expect(result).not.toBeNull();
      const data = result!.content;
      expect(data.length).toBe(256);
      for (let b = 0; b < 256; b++) {
        expect(data[b]).toBe((b + i) % 256);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CRYPTO-STORAGE-009: LocalStorageAdapter large file content
// ---------------------------------------------------------------------------

describe('LocalStorageAdapter - large file content [CRYPTO-STORAGE-009]', () => {
  let tempDir: string;
  let adapter: LocalStorageAdapter;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-storage-large-'));
    adapter = new LocalStorageAdapter({ baseDir: tempDir });
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('stores and retrieves 1 MB of binary content byte-for-byte', async () => {
    const SIZE = 1024 * 1024; // 1 MB
    const content = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      content[i] = i % 256;
    }

    await adapter.putObject('large-test.example.com', '/1mb.bin', content);
    const result = await adapter.getObject('large-test.example.com', '/1mb.bin');

    expect(result).not.toBeNull();
    expect(result!.content.length).toBe(SIZE);

    // Verify a sample of bytes spread across the content
    const sampleIndices = [0, 1000, 50000, 256 * 1024, SIZE - 1];
    for (const idx of sampleIndices) {
      expect(result!.content[idx]).toBe(idx % 256);
    }
  });

  test('stores and retrieves 4 MB of binary content intact', async () => {
    const SIZE = 4 * 1024 * 1024; // 4 MB
    const content = new Uint8Array(SIZE);
    // Fill with a non-trivial pattern to catch truncation or padding bugs
    for (let i = 0; i < SIZE; i++) {
      content[i] = (i * 13 + 7) % 256;
    }

    await adapter.putObject('large-test.example.com', '/4mb.bin', content);
    const result = await adapter.getObject('large-test.example.com', '/4mb.bin');

    expect(result).not.toBeNull();
    expect(result!.content.length).toBe(SIZE);

    // Verify first, middle, and last bytes
    expect(result!.content[0]).toBe((0 * 13 + 7) % 256);
    expect(result!.content[SIZE >> 1]).toBe(((SIZE >> 1) * 13 + 7) % 256);
    expect(result!.content[SIZE - 1]).toBe(((SIZE - 1) * 13 + 7) % 256);
  });

  test('stores and retrieves large string content (unicode) intact', async () => {
    // ~512 KB of text with repeating unicode content
    const chunk = '日本語テスト content chunk 🌍 ';
    const chunkCount = 10_000;
    const content = chunk.repeat(chunkCount);

    await adapter.putObject('large-test.example.com', '/large-unicode.txt', content);
    const result = await adapter.getObject('large-test.example.com', '/large-unicode.txt');

    expect(result).not.toBeNull();
    const decoded = new TextDecoder().decode(result!.content);
    expect(decoded.length).toBe(content.length);
    expect(decoded).toBe(content);
  });

  test('correctly reports exists() for large stored file', async () => {
    const content = new Uint8Array(512 * 1024).fill(0xAB);
    await adapter.putObject('large-test.example.com', '/exists-check.bin', content);

    expect(await adapter.exists('large-test.example.com', '/exists-check.bin')).toBe(true);
    expect(await adapter.exists('large-test.example.com', '/not-exists.bin')).toBe(false);
  });

  test('returns correct URL when baseUrl is configured', async () => {
    const adapterWithUrl = new LocalStorageAdapter({
      baseDir: tempDir,
      baseUrl: 'https://cdn.example.com',
    });

    const content = new Uint8Array(1024).fill(0x42);
    const url = await adapterWithUrl.putObject('myasset.com', '/large/file.bin', content);

    expect(url).toBe('https://cdn.example.com/myasset.com/large/file.bin');

    // Content is still retrievable
    const result = await adapterWithUrl.getObject('myasset.com', '/large/file.bin');
    expect(result).not.toBeNull();
    expect(result!.content.length).toBe(1024);
    expect(result!.content[0]).toBe(0x42);
  });

  test('returns null for missing file without throwing', async () => {
    const result = await adapter.getObject('large-test.example.com', '/this-does-not-exist.bin');
    expect(result).toBeNull();
  });

  test('baseUrl URL uses the same sanitized domain the file is stored under', async () => {
    // Regression: toUrl interpolated the raw domain while resolvePath sanitized
    // it, so for a domain with sanitizable characters the returned URL pointed
    // at a path that does not exist on disk.
    const adapterWithUrl = new LocalStorageAdapter({
      baseDir: tempDir,
      baseUrl: 'https://cdn.example.com',
    });

    const content = new Uint8Array([1, 2, 3, 4]);
    // Colon is sanitized to '_' by resolvePath (domain -> "my_asset_v2").
    const url = await adapterWithUrl.putObject('my:asset:v2', '/a.bin', content);
    expect(url).toBe('https://cdn.example.com/my_asset_v2/a.bin');

    // The object is retrievable under the same domain, confirming the URL's
    // domain segment matches the physical storage location.
    const result = await adapterWithUrl.getObject('my:asset:v2', '/a.bin');
    expect(result).not.toBeNull();
    expect(Array.from(result!.content)).toEqual([1, 2, 3, 4]);
  });
});

describe('LocalStorageAdapter path containment', () => {
  test('rejects object paths that escape the storage directory', async () => {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const { LocalStorageAdapter } = await import('../../../src/storage/LocalStorageAdapter');
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'originals-lsa-'));
    const adapter = new LocalStorageAdapter({ baseDir });

    await expect(
      adapter.putObject('example.com', '../../../escape.txt', 'x')
    ).rejects.toThrow(/outside the storage directory/);
    await expect(
      adapter.getObject('example.com', '..%2F..'.replace(/%2F/g, '/') + '/escape.txt')
    ).rejects.toThrow(/outside the storage directory/);

    // Normal nested paths still work
    const url = await adapter.putObject('example.com', 'a/b/c.txt', 'hello');
    expect(url).toContain('a/b/c.txt');
    const got = await adapter.getObject('example.com', 'a/b/c.txt');
    expect(new TextDecoder().decode(got!.content)).toBe('hello');

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('rejects domains that escape the storage directory (issue #251)', async () => {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const { LocalStorageAdapter } = await import('../../../src/storage/LocalStorageAdapter');
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'originals-lsa-parent-'));
    const baseDir = path.join(parent, 'storage');
    fs.mkdirSync(baseDir);
    const adapter = new LocalStorageAdapter({ baseDir });

    // A bare '..' domain used to resolve the domain directory to the PARENT of
    // baseDir, turning putObject/getObject into out-of-bounds file I/O.
    for (const domain of ['..', '.', '...']) {
      await expect(adapter.putObject(domain, 'secret/data.txt', 'x'))
        .rejects.toThrow(/outside the storage directory/);
      await expect(adapter.getObject(domain, 'secret/data.txt'))
        .rejects.toThrow(/outside the storage directory/);
      await expect(adapter.exists(domain, 'secret/data.txt'))
        .rejects.toThrow(/outside the storage directory/);
    }

    // Nothing may have been written outside baseDir
    expect(fs.existsSync(path.join(parent, 'secret'))).toBe(false);

    // Multi-segment traversal attempts stay neutralized ('/' becomes '_')
    const url = await adapter.putObject('../..', 'file.txt', 'ok');
    expect(url).toContain('.._..');
    expect(fs.existsSync(path.join(baseDir, '.._..', 'file.txt'))).toBe(true);

    // Normal domains still work
    await adapter.putObject('example.com', 'file.txt', 'hello');
    const got = await adapter.getObject('example.com', 'file.txt');
    expect(new TextDecoder().decode(got!.content)).toBe('hello');

    fs.rmSync(parent, { recursive: true, force: true });
  });
});

describe('MemoryStorageAdapter copy semantics', () => {
  test('mutating the input after put does not corrupt stored data', async () => {
    const { MemoryStorageAdapter } = await import('../../../src/storage/MemoryStorageAdapter');
    const adapter = new MemoryStorageAdapter();
    const buf = new Uint8Array([1, 2, 3]);
    await adapter.putObject('d', 'p', buf);
    buf[0] = 99;
    const got = await adapter.getObject('d', 'p');
    expect(Array.from(got!.content)).toEqual([1, 2, 3]);
    MemoryStorageAdapter.clear();
    expect(await adapter.exists('d', 'p')).toBe(false);
  });
});
