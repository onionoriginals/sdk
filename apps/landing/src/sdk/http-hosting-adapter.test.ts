import { describe, test, expect } from 'bun:test';
import { HttpHostingStorageAdapter } from './http-hosting-adapter';

function mockFetch() {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();
  const calls: Array<{ method: string; url: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    if (method === 'PUT') {
      const buf = new Uint8Array(init!.body as ArrayBuffer);
      const ct = (init!.headers as Record<string, string>)['content-type'] ?? 'application/octet-stream';
      store.set(url, { body: buf, contentType: ct });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const hit = store.get(url);
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(hit.body, { status: 200, headers: { 'content-type': hit.contentType } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('HttpHostingStorageAdapter', () => {
  test('put encodes the key, PUTs the bytes, and returns a resolvable URL', async () => {
    const { impl, calls } = mockFetch();
    const adapter = new HttpHostingStorageAdapter({ baseUrl: '', fetchImpl: impl });
    const key = 'demo.example.com/studio/you/did.jsonl';
    const url = await adapter.put(key, Buffer.from('{"a":1}\n{"b":2}'), {
      contentType: 'application/jsonl',
    });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('/api/host/' + encodeURIComponent(key));
    expect(url).toBe('https://' + key);
  });

  test('get returns content + contentType, null on miss', async () => {
    const { impl } = mockFetch();
    const adapter = new HttpHostingStorageAdapter({ baseUrl: '', fetchImpl: impl });
    const key = 'demo.example.com/.well-known/did.jsonl';
    await adapter.put(key, 'hello', { contentType: 'application/jsonl' });
    const got = await adapter.get(key);
    expect(got).not.toBeNull();
    expect(got!.content.toString()).toBe('hello');
    expect(got!.contentType).toBe('application/jsonl');
    expect(await adapter.get('nope/missing')).toBeNull();
  });

  test('put throws on a non-ok, non-2xx response', async () => {
    const failing = (async () => new Response('too big', { status: 413 })) as unknown as typeof fetch;
    const adapter = new HttpHostingStorageAdapter({ baseUrl: '', fetchImpl: failing });
    await expect(adapter.put('k', 'x', { contentType: 'text/plain' })).rejects.toThrow();
  });
});
