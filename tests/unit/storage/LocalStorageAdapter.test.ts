import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { LocalStorageAdapter } from '../../../src/storage/LocalStorageAdapter';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('LocalStorageAdapter', () => {
  describe('constructor', () => {
    test('initializes with baseDir', () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      expect(adapter).toBeDefined();
    });

    test('initializes with baseDir and baseUrl', () => {
      const adapter = new LocalStorageAdapter({
        baseDir: '/tmp/test',
        baseUrl: 'https://cdn.example.com'
      });
      expect(adapter).toBeDefined();
    });
  });

  describe('resolvePath (via putObject)', () => {
    test('sanitizes domain with special characters', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      await adapter.putObject('my@domain.com', 'file.txt', 'content');

      // Check that mkdir was called with sanitized domain
      const mkdirCall = mkdirSpy.mock.calls[0];
      const calledPath = mkdirCall[0] as string;
      expect(calledPath).toContain('my_domain.com');
      expect(calledPath).not.toContain('@');

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });

    test('removes leading slashes from objectPath', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      await adapter.putObject('domain.com', '///path/to/file.txt', 'content');

      const writeCall = writeFileSpy.mock.calls[0];
      const calledPath = writeCall[0] as string;
      expect(calledPath).toBe(path.join('/tmp/test', 'domain.com', 'path/to/file.txt'));

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });

    test('handles non-ASCII characters in domain', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      await adapter.putObject('münchen.de', 'file.txt', 'content');

      const mkdirCall = mkdirSpy.mock.calls[0];
      const calledPath = mkdirCall[0] as string;
      expect(calledPath).toContain('m_nchen.de');

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });
  });

  describe('toUrl', () => {
    test('returns baseUrl-based URL when baseUrl is provided', async () => {
      const adapter = new LocalStorageAdapter({
        baseDir: '/tmp/test',
        baseUrl: 'https://cdn.example.com/'
      });
      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      const url = await adapter.putObject('domain.com', 'path/file.txt', 'content');

      expect(url).toBe('https://cdn.example.com/domain.com/path/file.txt');

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });

    test('trims trailing slash from baseUrl', async () => {
      const adapter = new LocalStorageAdapter({
        baseDir: '/tmp/test',
        baseUrl: 'https://cdn.example.com///'
      });
      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      const url = await adapter.putObject('domain.com', 'file.txt', 'content');

      expect(url).toBe('https://cdn.example.com/domain.com/file.txt');

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });

    test('returns file:// URL when baseUrl is not provided', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      const url = await adapter.putObject('domain.com', 'file.txt', 'content');

      expect(url).toMatch(/^file:\/\//);
      expect(url).toContain('domain.com');
      expect(url).toContain('file.txt');

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });

    test('removes leading slashes from objectPath in URL', async () => {
      const adapter = new LocalStorageAdapter({
        baseDir: '/tmp/test',
        baseUrl: 'https://cdn.example.com'
      });
      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      const url = await adapter.putObject('domain.com', '//file.txt', 'content');

      expect(url).toBe('https://cdn.example.com/domain.com/file.txt');
      expect(url).not.toContain('///');

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });
  });

  describe('putObject', () => {
    test('creates directory recursively', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      await adapter.putObject('domain.com', 'deep/path/to/file.txt', 'content');

      expect(mkdirSpy).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });

    test('writes string content as Buffer', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      await adapter.putObject('domain.com', 'file.txt', 'string content');

      const writeCall = writeFileSpy.mock.calls[0];
      const data = writeCall[1];
      expect(Buffer.isBuffer(data)).toBe(true);
      expect(data.toString()).toBe('string content');

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });

    test('writes Uint8Array content as Buffer', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      const uint8Data = new Uint8Array([1, 2, 3, 4]);
      await adapter.putObject('domain.com', 'file.bin', uint8Data);

      const writeCall = writeFileSpy.mock.calls[0];
      const data = writeCall[1];
      expect(Buffer.isBuffer(data)).toBe(true);
      expect(Array.from(data)).toEqual([1, 2, 3, 4]);

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });

    test('returns URL after successful write', async () => {
      const adapter = new LocalStorageAdapter({
        baseDir: '/tmp/test',
        baseUrl: 'https://cdn.example.com'
      });
      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      const url = await adapter.putObject('domain.com', 'file.txt', 'content');

      expect(url).toBe('https://cdn.example.com/domain.com/file.txt');

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
    });
  });

  describe('getObject', () => {
    test('returns content as Uint8Array on success', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const fileContent = Buffer.from('file content');
      const readFileSpy = spyOn(fs, 'readFile').mockResolvedValue(fileContent);

      const result = await adapter.getObject('domain.com', 'file.txt');

      expect(result).not.toBeNull();
      expect(result?.content).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(result!.content).toString()).toBe('file content');

      readFileSpy.mockRestore();
    });

    test('returns null for ENOENT error', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const error: any = new Error('File not found');
      error.code = 'ENOENT';
      const readFileSpy = spyOn(fs, 'readFile').mockRejectedValue(error);

      const result = await adapter.getObject('domain.com', 'missing.txt');

      expect(result).toBeNull();

      readFileSpy.mockRestore();
    });

    test('throws error for non-ENOENT errors', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const error: any = new Error('Permission denied');
      error.code = 'EACCES';
      const readFileSpy = spyOn(fs, 'readFile').mockRejectedValue(error);

      await expect(adapter.getObject('domain.com', 'file.txt')).rejects.toThrow('Permission denied');

      readFileSpy.mockRestore();
    });

    test('throws error when error has no code', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const error = new Error('Unknown error');
      const readFileSpy = spyOn(fs, 'readFile').mockRejectedValue(error);

      await expect(adapter.getObject('domain.com', 'file.txt')).rejects.toThrow('Unknown error');

      readFileSpy.mockRestore();
    });

    test('handles error with null value', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const error: any = null;
      const readFileSpy = spyOn(fs, 'readFile').mockRejectedValue(error);

      // Null error should still be thrown
      await expect(adapter.getObject('domain.com', 'file.txt')).rejects.toBe(null);

      readFileSpy.mockRestore();
    });
  });

  describe('exists', () => {
    test('returns true when file exists', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const accessSpy = spyOn(fs, 'access').mockResolvedValue(undefined);

      const result = await adapter.exists('domain.com', 'file.txt');

      expect(result).toBe(true);

      accessSpy.mockRestore();
    });

    test('returns false when file does not exist', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const accessSpy = spyOn(fs, 'access').mockRejectedValue(new Error('ENOENT'));

      const result = await adapter.exists('domain.com', 'missing.txt');

      expect(result).toBe(false);

      accessSpy.mockRestore();
    });

    test('returns false for any access error', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const accessSpy = spyOn(fs, 'access').mockRejectedValue(new Error('EACCES'));

      const result = await adapter.exists('domain.com', 'file.txt');

      expect(result).toBe(false);

      accessSpy.mockRestore();
    });
  });

  describe('integration scenarios', () => {
    test('putObject and getObject work together', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      const content = 'test content';
      let storedData: Buffer | undefined;

      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockImplementation(async (_path, data) => {
        storedData = Buffer.from(data as any);
      });
      const readFileSpy = spyOn(fs, 'readFile').mockImplementation(async () => {
        if (!storedData) throw new Error('No data');
        return storedData;
      });

      await adapter.putObject('domain.com', 'test.txt', content);
      const result = await adapter.getObject('domain.com', 'test.txt');

      expect(result).not.toBeNull();
      expect(Buffer.from(result!.content).toString()).toBe(content);

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
      readFileSpy.mockRestore();
    });

    test('exists returns true after putObject', async () => {
      const adapter = new LocalStorageAdapter({ baseDir: '/tmp/test' });
      let fileExists = false;

      const mkdirSpy = spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      const writeFileSpy = spyOn(fs, 'writeFile').mockImplementation(async () => {
        fileExists = true;
      });
      const accessSpy = spyOn(fs, 'access').mockImplementation(async () => {
        if (!fileExists) throw new Error('ENOENT');
      });

      await adapter.putObject('domain.com', 'test.txt', 'content');
      const result = await adapter.exists('domain.com', 'test.txt');

      expect(result).toBe(true);

      mkdirSpy.mockRestore();
      writeFileSpy.mockRestore();
      accessSpy.mockRestore();
    });
  });
});
