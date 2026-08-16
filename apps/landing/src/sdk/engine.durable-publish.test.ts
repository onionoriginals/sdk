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
    // subOrgId must match the JWT sub the server verifies ('sub-1'), so the
    // per-user slug the engine publishes under passes the namespace guard.
    const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
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

  // The SDK persists a layer-agnostic copy of the CEL at `cel/<did:cel digest>.json`
  // — the key DIDManager.resolveDID's did:cel branch reads back. The host-key
  // guard used to reject that shape (403 → a swallowed cel:host-failed warning),
  // so the copy never landed on the durable path.
  test('the layer-agnostic CEL copy lands and is refreshed after the migrate append', async () => {
    const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
    const sdk = (engine as unknown as {
      sdk: {
        lifecycle: { on(t: string, h: (e: unknown) => void): void };
        did: { resolveDID(did: string, o?: { skipCache?: boolean }): Promise<unknown> };
      };
    }).sdk;
    const hostFailures: unknown[] = [];
    sdk.lifecycle.on('cel:host-failed', (e) => hostFailures.push(e));

    await engine.create('Copied Piece', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await engine.publish();

    const didCel = engine.asset!.id;
    expect(didCel.startsWith('did:cel:')).toBe(true);
    const res = store.read('sub-1', `cel/${didCel.slice('did:cel:'.length)}.json`);
    expect(res.status).toBe(200);
    // Refreshed AFTER the migrate append, not frozen at genesis.
    expect((JSON.parse(await res.text()) as { events: unknown[] }).events.length).toBe(2);
    expect(hostFailures).toEqual([]);

    // The point of the copy: did:cel now resolves from storage (network read,
    // not the in-memory cache) via DIDManager's did:cel branch.
    const resolved = (await sdk.did.resolveDID(didCel, { skipCache: true })) as { id?: string } | null;
    expect(resolved?.id).toBe(didCel);
  });
});
