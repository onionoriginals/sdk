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

  test.each([
    ['localhost:3000', 'https://localhost:3000', 'localhost:3000'],
    ['example.com:8443', 'https://example.com:8443/', 'example.com:8443'],
    ['example.com:443', 'https://example.com', 'example.com'],
    ['example.com:443', 'https://example.com:443/', 'example.com'],
    ['EXAMPLE.com:08443', 'https://example.com:8443', 'example.com:8443'],
    ['example.com', 'https://example.com:443/', 'example.com'],
    ['example.com:443', undefined, 'example.com'],
    ['localhost:3000', undefined, 'localhost:3000'],
  ])('port origin %s with baseUrl %s round-trips at canonical domain %s', async (originDomain, baseUrl, canonicalDomain) => {
    const adapter = new LocalStorageAdapter({ baseDir: tempDir, originDomain, baseUrl });
    expect(await adapter.putObject(originDomain, 'a/data.bin', 'content'))
      .toBe(`https://${canonicalDomain}/a/data.bin`);
    expect(fs.readFileSync(path.join(tempDir, 'a/data.bin'), 'utf8')).toBe('content');
    expect(await adapter.exists(canonicalDomain, 'a/data.bin')).toBe(true);
    expect(await adapter.listObjects(canonicalDomain, 'a/')).toEqual(['a/data.bin']);
    expect(new TextDecoder().decode((await adapter.getObject(canonicalDomain, 'a/data.bin'))!.content)).toBe('content');
    await expect(adapter.putObject('other.com', 'bad.bin', 'bad')).rejects.toMatchObject({ code: 'STORAGE_DOMAIN_MISMATCH' });
    const wrongPort = canonicalDomain.startsWith('localhost') ? 'localhost:3001' : 'example.com:9443';
    await expect(adapter.putObject(wrongPort, 'a/data.bin', 'bad')).rejects.toMatchObject({ code: 'STORAGE_DOMAIN_MISMATCH' });
    await expect(adapter.getObject(wrongPort, 'a/data.bin')).rejects.toMatchObject({ code: 'STORAGE_DOMAIN_MISMATCH' });
    await expect(adapter.exists(wrongPort, 'a/data.bin')).rejects.toMatchObject({ code: 'STORAGE_DOMAIN_MISMATCH' });
    await expect(adapter.listObjects(wrongPort, '')).rejects.toMatchObject({ code: 'STORAGE_DOMAIN_MISMATCH' });
    expect(fs.readFileSync(path.join(tempDir, 'a/data.bin'), 'utf8')).toBe('content');
  });

  test.each([
    'https://localhost', 'https://localhost:443', 'https://localhost:3001',
    'http://localhost:3000', 'https://user:pass@localhost:3000',
    'https://@localhost:3000', 'https://localhost:3000/path',
    'https://localhost:3000/a/..', 'https://localhost:3000/%2e/',
    'https://localhost:3000?', 'https://localhost:3000#',
    'https://localhost:3000?q=1', 'https://localhost:3000#fragment',
    'https://localhost:3000\\', 'https://localhost:3000\\a\\..',
    ' https://localhost:3000', 'https://localhost:3000\n',
    'https://local\thost:3000', 'https://%6cocalhost:3000',
    'https:////localhost:3000',
  ])('rejects unsafe or mismatched port origin %j', (baseUrl) => {
    expect(() => new LocalStorageAdapter({ baseDir: tempDir, originDomain: 'localhost:3000', baseUrl }))
      .toThrow(expect.objectContaining({ code: 'STORAGE_INVALID_ORIGIN' }));
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  test.each([
    '', 'example.com/', 'example.com/path', 'example.com/a/..',
    'user@example.com', '@example.com', 'example.com?', 'example.com#',
    'example.com\\', ' example.com', 'example.com\n', '%65xample.com',
    'https://example.com', 'example.com:', 'example.com:invalid', 'example.com:65536',
  ])('validates configured originDomain even without a baseUrl (%j)', (originDomain) => {
    for (const baseUrl of [undefined, `https://${originDomain}`]) {
      expect(() => new LocalStorageAdapter({ baseDir: tempDir, originDomain, baseUrl }))
        .toThrow(expect.objectContaining({ code: 'STORAGE_INVALID_ORIGIN' }));
    }
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

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
