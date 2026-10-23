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

export function host() {
  const store = createOriginalsStore({ dataDir: mkdtempSync(join(tmpdir(), 'landing-publish-')) });
  const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
  const noop = { async handlePut() { return new Response(null, { status: 501 }); }, read() { return new Response(null, { status: 404 }); }, serve() { return null as Response | null; } };
  const serve = buildFetch({ apiRoutes: null, hostStore: noop, distDir: '/nonexistent/', originals });
  const cookie = serializeCookie(getAuthCookieConfig(signToken(SUB, 'p@example.com', undefined, { secret: JWT })));
  const upload = new DurableHostingStorageAdapter({
    baseUrl: 'http://app.local',
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init);
      r.headers.set('cookie', cookie);
      return serve(r);
    }) as typeof fetch,
  });
  // A stranger's fetch: the HTTPS URL a resolver derives, answered by the same server.
  const read: HostedFetch = async (url) => {
    const res = await serve(new Request(url.replace(/^https:/, 'http:')));
    if (!res.ok) throw new OriginalsError('unavailable-bytes', 'FETCH_STATUS', `${url} answered ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  return { upload, read };
}

