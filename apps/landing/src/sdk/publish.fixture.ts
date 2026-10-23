/**
 * Test fixture: the landing's real hosting routes and durable store on a temp
 * directory, an authenticated uploader, and a stranger's HTTPS reader.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OriginalsError } from '@originals/vh';
import type { HostedFetch } from '@originals/sdk/originals';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { DurableHostingStorageAdapter } from './durable-hosting-adapter';
import { createOriginalsStore } from '../../server/originals-store';
import { createOriginalsRoutes } from '../../server/originals-routes';
import { buildFetch } from '../../server/app';
import { serializeCookie } from '../../server/cookies';

export const JWT = 'test-secret-at-least-32-chars-long!!';
export const SUB = 'sub-publisher-0001';
export const DOMAIN = 'demo.example.com';

export function cookieFor(sub: string): string {
  return serializeCookie(getAuthCookieConfig(signToken(sub, `${sub}@example.com`, undefined, { secret: JWT })));
}

export function host() {
  const dataDir = mkdtempSync(join(tmpdir(), 'landing-publish-'));
  const store = createOriginalsStore({ dataDir });
  const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
  const noop = { async handlePut() { return new Response(null, { status: 501 }); }, read() { return new Response(null, { status: 404 }); }, serve() { return null as Response | null; } };
  // The account index routes, as server/index.ts mounts them (#976 B, G3).
  const apiRoutes = { 'POST /api/originals': originals.record, 'GET /api/originals': originals.list };
  const serve = buildFetch({ apiRoutes, hostStore: noop, distDir: '/nonexistent/', originals });
  /** A browser signed in as `sub` (no cookie when null), talking to the app's origin. */
  const fetchAs = (sub: string | null) =>
    ((input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init);
      if (sub) r.headers.set('cookie', cookieFor(sub));
      return serve(r);
    }) as typeof fetch;
  const adapterFor = (sub: string) => new DurableHostingStorageAdapter({ baseUrl: 'http://app.local', fetchImpl: fetchAs(sub) });
  const upload = adapterFor(SUB);
  // A stranger's fetch: the HTTPS URL a resolver derives, answered by the same server.
  const read: HostedFetch = async (url) => {
    const res = await serve(new Request(url.replace(/^https:/, 'http:')));
    if (!res.ok) throw new OriginalsError('unavailable-bytes', 'FETCH_STATUS', `${url} answered ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  return { upload, read, serve, fetchAs, adapterFor, dataDir };
}
