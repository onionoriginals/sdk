import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import { createOriginalsStore } from '../originals-store';
import { createOriginalsRoutes } from '../originals-routes';
import { buildFetch } from '../app';

const JWT = 'test-secret-at-least-32-chars-long!!';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'originals-routes-'));
  return createOriginalsStore({ dataDir: dir });
}
function cookieFor(sub: string): string {
  return serializeCookie(getAuthCookieConfig(signToken(sub, `${sub}@b.com`, undefined, { secret: JWT })));
}

describe('originals routes — auth gating', () => {
  test('GET/POST /api/originals + PUT host are 401 when anonymous', async () => {
    const routes = createOriginalsRoutes({ jwtSecret: JWT, store: tmpStore() });
    const listRes = await routes.list(new Request('http://h/api/originals'), new URL('http://h/api/originals'));
    expect(listRes.status).toBe(401);
    const recRes = await routes.record(
      new Request('http://h/api/originals', { method: 'POST', body: '{}' }),
      new URL('http://h/api/originals')
    );
    expect(recRes.status).toBe(401);
    const putUrl = new URL('http://h/api/originals/host/demo.example.com/studio/you/abc/did.jsonl');
    const putRes = await routes.hostPut(new Request(putUrl, { method: 'PUT', body: 'x' }), putUrl, '1.1.1.1');
    expect(putRes.status).toBe(401);
  });

  test('record then list under the authenticated sub', async () => {
    const routes = createOriginalsRoutes({ jwtSecret: JWT, store: tmpStore() });
    const cookie = cookieFor('sub-1');
    const rec = await routes.record(
      new Request('http://h/api/originals', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ did: 'did:webvh:S:demo.example.com:studio:you:abc', title: 'Piece', resourceHash: 'deadbeef' }),
      }),
      new URL('http://h/api/originals')
    );
    expect(rec.status).toBe(200);

    const list = await routes.list(
      new Request('http://h/api/originals', { headers: { cookie } }),
      new URL('http://h/api/originals')
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { originals: Array<{ title: string }> };
    expect(body.originals.map((o) => o.title)).toEqual(['Piece']);
  });

  test('PUT host stores durably and buildFetch serves it at the resolver URL', async () => {
    const store = tmpStore();
    const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
    const fetchFn = buildFetch({ apiRoutes: null, hostStore: noopHostStore(), distDir: '/nonexistent/', originals });

    const key = 'demo.example.com/studio/you/abc/did.jsonl';
    const putRes = await fetchFn(
      new Request(`http://demo.local/api/originals/host/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/jsonl', cookie: cookieFor('sub-1') },
        body: '{"v":1}',
      })
    );
    expect(putRes.status).toBe(200);

    // Anyone GETting the resolver URL gets the durable object via the serve fallback.
    const getRes = await fetchFn(new Request('http://demo.example.com/studio/you/abc/did.jsonl'));
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('{"v":1}');
    expect(getRes.headers.get('content-disposition')).toBe('attachment');
  });
});

// The ephemeral host store surface buildFetch also depends on — a no-op here.
function noopHostStore() {
  return {
    async handlePut() { return new Response(null, { status: 501 }); },
    read() { return new Response(null, { status: 404 }); },
    serve() { return null as Response | null; },
  };
}
