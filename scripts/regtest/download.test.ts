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
        downloadArchive(server.url.href, path, 'unused', 50, []).then(() => 'completed', error => (error as Error).name),
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

  test('retries a transient failure with backoff, and never a digest mismatch or a 404', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'originals-download-test-'));
    const bytes = new Uint8Array([7, 7, 7]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    let requests = 0;
    let failures = 2;
    let status = 200;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      requests++;
      if (failures-- > 0) return new Response('busy', { status: 503 });
      return new Response(status === 200 ? bytes : 'gone', { status });
    } });
    try {
      const path = join(directory, 'flaky.tar.gz');
      await downloadArchive(server.url.href, path, digest, 1000, [0, 0]);
      expect(requests).toBe(3);
      expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(bytes);
      requests = 0; failures = 0;
      await expect(downloadArchive(server.url.href, join(directory, 'bad.tar.gz'), '0'.repeat(64), 1000, [0, 0])).rejects.toThrow('SHA256 mismatch');
      expect(requests).toBe(1);
      requests = 0; status = 404;
      await expect(downloadArchive(server.url.href, join(directory, 'missing.tar.gz'), digest, 1000, [0, 0])).rejects.toThrow('404');
      expect(requests).toBe(1);
      // Out of retries: the last transient error is thrown.
      requests = 0; failures = 5; status = 200;
      await expect(downloadArchive(server.url.href, join(directory, 'down.tar.gz'), digest, 1000, [0, 0])).rejects.toThrow('503');
      expect(requests).toBe(3);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
