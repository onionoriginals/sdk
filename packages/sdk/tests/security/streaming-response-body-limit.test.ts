import { describe, test, expect, afterEach } from 'bun:test';
import { readResponseBodyCapped, ResponseTooLargeError } from '../../src/adapters/response-body-limit';
import { QuickNodeProvider } from '../../src/adapters/providers/QuickNodeProvider';
import { OrdHttpProvider } from '../../src/adapters/providers/OrdHttpProvider';
import { StructuredError } from '@originals/cel';

/**
 * Issue #606: a chunked/streamed response has no reliable Content-Length, so
 * reading it via `Response.arrayBuffer()` first materializes the ENTIRE body
 * before its size is ever checked. These tests prove the cap is enforced
 * WHILE STREAMING — the reader must stop pulling and cancel the underlying
 * stream as soon as it has observed more than the configured cap, never
 * buffering the full oversized body first.
 */

/** A streamed response with no Content-Length header, tracking how much of it was actually pulled. */
function chunkedResponse(chunkSize: number, chunkCount: number, headers?: Record<string, string>) {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls > chunkCount) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      cancelled = true;
    },
  });
  const res = new Response(stream, { headers });
  return { res, getPulls: () => pulls, wasCancelled: () => cancelled };
}

describe('readResponseBodyCapped (issue #606)', () => {
  test('a declared Content-Length above the cap is rejected before reading the body', async () => {
    let bodyRead = false;
    const fake = {
      headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? String(50 * 1024 * 1024) : null) },
      body: null,
      async arrayBuffer() {
        bodyRead = true;
        return new Uint8Array(1).buffer;
      },
    } as unknown as Response;
    await expect(readResponseBodyCapped(fake, 1024)).rejects.toThrow(ResponseTooLargeError);
    expect(bodyRead).toBe(false);
  });

  test('aborts a chunked, no-Content-Length body as soon as the cap is exceeded, without buffering the full stream', async () => {
    const chunkSize = 64 * 1024; // 64 KiB per chunk
    const chunkCount = 1000; // ~64 MiB if fully drained
    const { res, getPulls, wasCancelled } = chunkedResponse(chunkSize, chunkCount);
    expect(res.headers.get('content-length')).toBeNull();

    const cap = 256 * 1024; // 4 chunks
    await expect(readResponseBodyCapped(res, cap)).rejects.toThrow(ResponseTooLargeError);

    // Must stop long before the 1000-chunk stream completes: it never buffers
    // anywhere near the full body once the cap has been exceeded.
    expect(getPulls()).toBeLessThan(10);
    expect(wasCancelled()).toBe(true);
  });

  test('accepts a chunked body within the cap and returns its exact bytes', async () => {
    const { res } = chunkedResponse(10, 5); // 50 bytes total, no Content-Length
    const bytes = await readResponseBodyCapped(res, 100);
    expect(bytes.byteLength).toBe(50);
  });

  test('falls back to arrayBuffer() for response-like objects without a streaming body', async () => {
    const fake = {
      headers: { get: () => null },
      async arrayBuffer() {
        return new Uint8Array(10).buffer;
      },
    } as unknown as Response;
    const bytes = await readResponseBodyCapped(fake, 100);
    expect(bytes.byteLength).toBe(10);
    await expect(readResponseBodyCapped(fake, 5)).rejects.toThrow(ResponseTooLargeError);
  });
});

describe('QuickNodeProvider streams JSON-RPC responses under the configured cap (issue #606)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('a chunked JSON-RPC response exceeding maxJsonBytes is rejected without buffering the full body', async () => {
    const chunkSize = 64 * 1024;
    const chunkCount = 1000;
    let pulls = 0;
    let cancelled = false;
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls > chunkCount) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(chunkSize));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream);
    }) as any;

    const provider = new QuickNodeProvider({ endpoint: 'https://example-name.btc.quiknode.pro/test-token/', maxJsonBytes: 256 * 1024 });
    await expect(provider.getInscriptionsBySatoshi('123')).rejects.toMatchObject({ code: 'QUICKNODE_RESPONSE_TOO_LARGE' });
    expect(pulls).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });
});

describe('OrdHttpProvider streams content/metadata responses under the configured cap (issue #606)', () => {
  const originalFetch = globalThis.fetch;
  const BASE = 'https://ord.example.com/api';
  const ID = 'a'.repeat(64) + 'i0';
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('a chunked content body with no Content-Length exceeding maxContentBytes is rejected without buffering the full stream', async () => {
    const chunkSize = 64 * 1024;
    const chunkCount = 1000;
    let pulls = 0;
    let cancelled = false;
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/inscription/')) {
        return new Response(JSON.stringify({ content_type: 'application/octet-stream' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('/r/metadata/')) {
        return new Response('', { status: 404 });
      }
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls > chunkCount) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(chunkSize));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream);
    }) as any;

    const provider = new OrdHttpProvider({ baseUrl: BASE, maxContentBytes: 256 * 1024 });
    await expect(provider.getInscriptionById(ID)).rejects.toThrow(/exceeds .* bytes/);
    expect(pulls).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });
});
