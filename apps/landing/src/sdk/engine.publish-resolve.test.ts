import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { verifyHistory } from '@originals/sdk/cel';
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
      if (method === 'GET') return store.read(url);
      const req = new Request(url, {
        method,
        headers: init?.headers as HeadersInit,
        body: init?.body as BodyInit,
      });
      return method === 'GET' ? store.read(url) : store.handlePut(req, url);
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

    expect(engine.asset!.celLog.log[0].event.operation.type).toBe('create');
    expect(verifyHistory(engine.asset!.celLog).state.layer).toBe('webvh');
    expect(state.webvhDid).toContain(':published:anonymous:');
    expect(state.layer).toBe('did:webvh');
    expect(state.webvhDid).toContain(`:${host}:`);
    expect(state.webvhLogUrl).toBe(expectedUrl);
    expect(state.webvhResolved).toBe(true);

    expect(resolvedEvents.length).toBe(1);
    expect(resolvedEvents[0].logUrl).toBe(expectedUrl);
    expect(resolvedEvents[0].resolved).toBe(true);
  });
  test('a cold engine restores exact PNG bytes and all revised versions', async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    const engine = new DemoEngine();
    await engine.create('My PNG', 'Upload', { filename: 'mine.png', content: png, contentType: 'image/png' });
    const published = await engine.publish();
    const next = Uint8Array.from([...png, 1]);
    await engine.update('New PNG', 'Upload', { filename: 'mine.png', content: next, contentType: 'image/png' });
    const cold = new DemoEngine();
    const state = await cold.hydrateFromWeb(published.webvhDid!);
    expect(state.did).toBe(published.did);
    expect(state.webvhDid).toBe(published.webvhDid);
    expect(state.resource.version).toBe(2);
    expect(state.resource.content).toEqual(next);
    expect(cold.asset!.resources.filter((r) => r.id === 'mine.png').map((r) => r.content)).toEqual([png, next]);
    expect(state.webvhResolved).toBe(true);
  });

});
