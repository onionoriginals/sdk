import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { DemoEngine } from './engine';
import { createOriginalsStore } from '../../server/originals-store';
import { createOriginalsRoutes } from '../../server/originals-routes';
import { createWebvhHostStore } from '../../server/webvh-host';
import { buildFetch } from '../../server/app';

const JWT = 'test-secret-at-least-32-chars-long!!';
const HOST = 'demo.test';

// Route the browser's durable PUTs, the summary POST, AND the resolver's https
// GETs through one in-process server (buildFetch) with a real durable store.
function installServerFetch(store: ReturnType<typeof createOriginalsStore>) {
  const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
  const apiRoutes = { 'POST /api/originals': originals.record, 'GET /api/originals': originals.list } as Record<
    string,
    (req: Request, url: URL) => Response | Promise<Response>
  >;
  const fetchFn = buildFetch({ apiRoutes, hostStore: createWebvhHostStore(), distDir: '/nonexistent/', originals });
  const cookie = getAuthCookieConfig(signToken('sub-1', 's@b.com', undefined, { secret: JWT }));
  const cookieHeader = `${cookie.name}=${cookie.value}`;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = new URL(raw, `http://${HOST}`);
    const headers = new Headers(init?.headers as HeadersInit);
    headers.set('cookie', cookieHeader); // the browser would attach the auth cookie
    return fetchFn(new Request(url, { ...init, headers }));
  }) as unknown as typeof fetch;
  return () => { globalThis.fetch = real; };
}

describe('authed durable publish', () => {
  let restore: () => void;
  let store: ReturnType<typeof createOriginalsStore>;

  beforeEach(() => {
    (import.meta as unknown as { env: Record<string, string> }).env ??= {};
    (import.meta as unknown as { env: Record<string, string> }).env.VITE_WEBVH_HOST = HOST;
    store = createOriginalsStore({ dataDir: mkdtempSync(join(tmpdir(), 'engine-durable-')) });
    restore = installServerFetch(store);
  });
  afterEach(() => restore());

  test('authed publish hosts durably and records a summary', async () => {
    const engine = new DemoEngine({ authed: true });
    await engine.create('Durable Piece', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const state = await engine.publish();

    expect(state.layer).toBe('did:webvh');
    // The summary was recorded under the authed sub.
    const list = store.list('sub-1');
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('Durable Piece');
    expect(list[0].did).toBe(state.webvhDid);
    // The did log is durably served at its resolver URL.
    const served = store.serve(new URL(state.webvhLogUrl!.replace('https://', 'http://')));
    expect(served).not.toBeNull();
  });
});
