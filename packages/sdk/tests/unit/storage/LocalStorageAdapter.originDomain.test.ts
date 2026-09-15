import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalStorageAdapter } from '../../../src/storage/LocalStorageAdapter';
import { StructuredError } from '@originals/cel';

describe('LocalStorageAdapter originDomain mode (#780)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-storage-origin-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns the canonical https://domain/path URL with no repeated domain segment', async () => {
    const adapter = new LocalStorageAdapter({
      baseDir: tempDir,
      baseUrl: 'https://example.com',
      originDomain: 'example.com',
    });
    const url = await adapter.putObject('example.com', 'published/anonymous/x/did.jsonl', 'content');
    expect(url).toBe('https://example.com/published/anonymous/x/did.jsonl');
  });

  test('derives the origin from originDomain alone when baseUrl is omitted', async () => {
    const adapter = new LocalStorageAdapter({ baseDir: tempDir, originDomain: 'example.com' });
    const url = await adapter.putObject('example.com', 'a.bin', new Uint8Array([1]));
    expect(url).toBe('https://example.com/a.bin');
  });

  test('putObject for a different domain throws STORAGE_DOMAIN_MISMATCH instead of silently mismapping', async () => {
    const adapter = new LocalStorageAdapter({ baseDir: tempDir, originDomain: 'example.com' });
    let thrown: unknown;
    try {
      await adapter.putObject('other.com', 'a.bin', new Uint8Array([1]));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StructuredError);
    expect((thrown as StructuredError).code).toBe('STORAGE_DOMAIN_MISMATCH');
  });

  test('getObject/exists/listObjects for a different domain also throw STORAGE_DOMAIN_MISMATCH', async () => {
    const adapter = new LocalStorageAdapter({ baseDir: tempDir, originDomain: 'example.com' });
    await adapter.putObject('example.com', 'a.bin', new Uint8Array([1]));

    await expect(adapter.getObject('other.com', 'a.bin')).rejects.toBeInstanceOf(StructuredError);
    await expect(adapter.exists('other.com', 'a.bin')).rejects.toBeInstanceOf(StructuredError);
    await expect(adapter.listObjects('other.com', '')).rejects.toBeInstanceOf(StructuredError);
  });

  test('content written and read through originDomain mode round-trips intact', async () => {
    const adapter = new LocalStorageAdapter({ baseDir: tempDir, originDomain: 'example.com' });
    const data = new Uint8Array([9, 8, 7, 6]);
    await adapter.putObject('example.com', 'data.bin', data);
    const result = await adapter.getObject('example.com', 'data.bin');
    expect(result).not.toBeNull();
    expect(Array.from(result!.content)).toEqual([9, 8, 7, 6]);
  });

  test('without originDomain, existing multi-tenant baseUrl behavior is unchanged', async () => {
    const adapter = new LocalStorageAdapter({ baseDir: tempDir, baseUrl: 'https://cdn.example.com' });
    const url = await adapter.putObject('myasset.com', 'a.bin', new Uint8Array([1]));
    expect(url).toBe('https://cdn.example.com/myasset.com/a.bin');
  });

  test('originDomain mode stores files directly under baseDir, with no per-domain subdirectory, matching the advertised URL', async () => {
    // A static file server rooted at baseDir must find the file at exactly
    // the path toUrl() advertises (`a/b.bin`) — not nested under a domain
    // subdirectory it never mentions.
    const adapter = new LocalStorageAdapter({ baseDir: tempDir, originDomain: 'example.com' });
    await adapter.putObject('example.com', 'a/b.bin', new Uint8Array([1, 2]));
    expect(fs.existsSync(path.join(tempDir, 'a', 'b.bin'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'example.com', 'a', 'b.bin'))).toBe(false);
  });

  test('without originDomain, files still nest under a per-domain subdirectory (unchanged multi-tenant layout)', async () => {
    const adapter = new LocalStorageAdapter({ baseDir: tempDir });
    await adapter.putObject('myasset.com', 'a.bin', new Uint8Array([1]));
    expect(fs.existsSync(path.join(tempDir, 'myasset.com', 'a.bin'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'a.bin'))).toBe(false);
  });

  test.each([
    'http://example.com',
    'https://wrong-host.example',
    'https://example.com:8443',
    'https://example.com/some/prefix',
    'https://example.com?query=1',
    'https://example.com#frag',
    'not a url',
  ])(
    'constructor rejects a baseUrl that is not exactly the originDomain\'s bare HTTPS origin (%j)',
    (baseUrl) => {
      let thrown: unknown;
      try {
        new LocalStorageAdapter({ baseDir: tempDir, originDomain: 'example.com', baseUrl });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(StructuredError);
      expect((thrown as StructuredError).code).toBe('STORAGE_INVALID_ORIGIN');
    },
  );

  test.each(['https://example.com', 'https://example.com/'])(
    'constructor accepts a baseUrl that is exactly the originDomain\'s bare HTTPS origin (%j)',
    (baseUrl) => {
      expect(
        () => new LocalStorageAdapter({ baseDir: tempDir, originDomain: 'example.com', baseUrl }),
      ).not.toThrow();
    },
  );

  test('an invalid originDomain baseUrl is rejected before any storage write', () => {
    let thrown: unknown;
    try {
      new LocalStorageAdapter({ baseDir: tempDir, originDomain: 'example.com', baseUrl: 'http://example.com' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StructuredError);
    // No domain directory or bare file should have been created.
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });
});
