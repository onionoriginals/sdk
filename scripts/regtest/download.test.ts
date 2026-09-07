import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadArchive } from './download';

// These tests exercise real loopback response bodies, including Bun's abort path.
const nativeFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = nativeFetch; });

describe('regtest archive download', () => {
  test('aborts a stalled response body and leaves no cached archive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'originals-download-test-'));
    const path = join(directory, 'archive.tar.gz');
    let stalled = true;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      if (!stalled) return new Response(new Uint8Array([1]));
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }),
        { headers: { 'content-length': '1000' } });
    } });
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        downloadArchive(server.url.href, path, 'unused', 50).then(() => 'completed', error => (error as Error).name),
        new Promise<string>(resolve => { guard = setTimeout(() => resolve('body ignored timeout'), 1000); }),
      ]);
      expect(result).toBe('TimeoutError');
      expect(await Bun.file(path).exists()).toBe(false);
      stalled = false;
      await downloadArchive(server.url.href, path, createHash('sha256').update(new Uint8Array([1])).digest('hex'));
      expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(new Uint8Array([1]));
    } finally {
      clearTimeout(guard);
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('writes exact bytes only when the complete archive matches its pinned digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'originals-download-test-'));
    const bytes = new Uint8Array([0, 255, 1, 128]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(bytes) });
    try {
      const valid = join(directory, 'valid.tar.gz');
      await downloadArchive(server.url.href, valid, digest);
      expect(new Uint8Array(await Bun.file(valid).arrayBuffer())).toEqual(bytes);
      const invalid = join(directory, 'invalid.tar.gz');
      await expect(downloadArchive(server.url.href, invalid, '0'.repeat(64))).rejects.toThrow('SHA256 mismatch');
      expect(await Bun.file(invalid).exists()).toBe(false);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
