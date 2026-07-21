import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DemoEngine } from './engine';
import { createWebvhHostStore } from '../../server/webvh-host';

// Route the browser adapter's PUT /api/host/* AND the resolver's https GETs
// through one in-process host store, so publish → resolve is deterministic
// without a live HTTPS origin (Resolved fact #4).
function installHostFetch(host: string) {
  const store = createWebvhHostStore();
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(raw, `http://${host}`);
    if (url.pathname.startsWith('/api/host/')) {
      const req = new Request(url, {
        method,
        headers: init?.headers as HeadersInit,
        body: init?.body as BodyInit,
      });
      return store.handlePut(req, url);
    }
    // Resolver GET https://<host>/<path>/did.jsonl → serve from the store.
    const served = store.serve(new Request(url), url);
    if (served) return served;
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

describe('publish → resolve roundtrip', () => {
  const host = 'demo.test';
  let restore: () => void;

  beforeEach(() => {
    (import.meta as unknown as { env: Record<string, string> }).env ??= {};
    (import.meta as unknown as { env: Record<string, string> }).env.VITE_WEBVH_HOST = host;
    restore = installHostFetch(host);
  });
  afterEach(() => restore());

  test('publishes the DID log and resolves it back over (mocked) HTTPS', async () => {
    const engine = new DemoEngine();
    const resolvedEvents: Array<{ logUrl: string; resolved: boolean }> = [];
    engine.on((e) => {
      if (e.type === 'did:webvh:resolved') {
        resolvedEvents.push(e.payload as { logUrl: string; resolved: boolean });
      }
    });

    await engine.create('Roundtrip', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const state = await engine.publish();

    // publishToWeb hosts the ASSET's did:webvh log (content-addressed slug path),
    // not the publisher's — derive the expected resolvable URL from that did.
    const parts = state.webvhDid!.split(':'); // did:webvh:<SCID>:<host>:<slug>
    const expectedUrl = `https://${host}/${parts.slice(4).join('/')}/did.jsonl`;

    expect(state.layer).toBe('did:webvh');
    expect(state.webvhDid).toContain(`:${host}:`);
    expect(state.webvhLogUrl).toBe(expectedUrl);
    expect(state.webvhResolved).toBe(true);

    expect(resolvedEvents.length).toBe(1);
    expect(resolvedEvents[0].logUrl).toBe(expectedUrl);
    expect(resolvedEvents[0].resolved).toBe(true);
  });
});
