import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DemoEngine } from './engine';
import { createWebvhHostStore } from '../../server/webvh-host';

// R15: a store that is already full must not break the demo for the NEXT
// visitor. Before eviction this run failed at the first host write with a raw
// `HttpHostingStorageAdapter.put failed: 507`.
const host = 'demo.test';

function installHostFetch(store: ReturnType<typeof createWebvhHostStore>, client: string) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(raw, `http://${host}`);
    if (url.pathname.startsWith('/api/host/')) {
      if (method === 'GET' || method === 'HEAD') return store.read(url);
      const req = new Request(url, {
        method,
        headers: init?.headers as HeadersInit,
        body: init?.body as BodyInit,
      });
      return store.handlePut(req, url, client);
    }
    const served = store.serve(new Request(url), url);
    return served ?? new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

describe('a full anonymous demo run against a store at capacity', () => {
  let store: ReturnType<typeof createWebvhHostStore>;
  let restore: () => void;

  beforeEach(async () => {
    (import.meta as unknown as { env: Record<string, string> }).env ??= {};
    (import.meta as unknown as { env: Record<string, string> }).env.VITE_WEBVH_HOST = host;
    // Small caps so "at capacity" is reachable, then fill them from OTHER
    // visitors — the state a launch spike leaves behind.
    store = createWebvhHostStore({ maxEntries: 12, maxEntriesPerClient: 6, maxClients: 4 });
    const fill = installHostFetch(store, 'filler');
    for (let i = 0; i < 40; i++) {
      const key = `other.test/spike${i}/did.jsonl`;
      await store.handlePut(
        new Request(`http://host/api/host/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/jsonl' },
          body: 'filler',
        }),
        new URL(`http://host/api/host/${encodeURIComponent(key)}`),
        `10.0.0.${i % 8}`
      );
    }
    fill();
    expect(store.stats().entries).toBeLessThanOrEqual(12);
    restore = installHostFetch(store, 'new-visitor');
  });
  afterEach(() => restore());

  test('a new visitor still creates, publishes and resolves', async () => {
    const engine = new DemoEngine();
    await engine.create('Spike', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const state = await engine.publish();

    expect(state.layer).toBe('did:webvh');
    expect(state.webvhResolved).toBe(true);
  });
});
