import { describe, test, expect } from 'bun:test';
import { DurableHostingStorageAdapter } from './durable-hosting-adapter';

function mockFetch() {
  const calls: Array<{ method: string; url: string; credentials?: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url, credentials: init?.credentials });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('DurableHostingStorageAdapter', () => {
  test('put targets /api/originals/host/<encoded key> with same-origin credentials', async () => {
    const { impl, calls } = mockFetch();
    const adapter = new DurableHostingStorageAdapter({ baseUrl: '', fetchImpl: impl });
    const key = 'demo.example.com/studio/you/abc/did.jsonl';
    const url = await adapter.put(key, '{"v":1}', { contentType: 'application/jsonl' });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('/api/originals/host/' + encodeURIComponent(key));
    expect(calls[0].credentials).toBe('same-origin');
    expect(url).toBe('https://' + key);
  });

  test('put throws on a non-ok response', async () => {
    const failing = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const adapter = new DurableHostingStorageAdapter({ baseUrl: '', fetchImpl: failing });
    await expect(adapter.put('k', 'x', { contentType: 'text/plain' })).rejects.toThrow();
  });
});
