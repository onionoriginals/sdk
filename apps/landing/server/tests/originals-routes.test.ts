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
    const getRes = await routes.hostGet(new Request(putUrl), putUrl);
    expect(getRes.status).toBe(401);
  });

  test('PUT then GET on /api/originals/host/* round-trips (adapter.get path)', async () => {
    const store = tmpStore();
    const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
    const fetchFn = buildFetch({ apiRoutes: null, hostStore: noopHostStore(), distDir: '/nonexistent/', originals });
    const key = 'demo.example.com/user-sub-1/abc/did.jsonl';
    const endpoint = `http://demo.local/api/originals/host/${encodeURIComponent(key)}`;
    const cookie = cookieFor('sub-1');

    const putRes = await fetchFn(
      new Request(endpoint, { method: 'PUT', headers: { 'content-type': 'application/jsonl', cookie }, body: '{"v":1}' })
    );
    expect(putRes.status).toBe(200);

    // GET on the same path must NOT 405 — it reads the object back (was the P1 bug).
    const getRes = await fetchFn(new Request(endpoint, { headers: { cookie } }));
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('{"v":1}');

    // A key this user never wrote → 404, which the adapter maps to null.
    const missUrl = `http://demo.local/api/originals/host/${encodeURIComponent('demo.example.com/user-sub-1/nope/did.jsonl')}`;
    const missRes = await fetchFn(new Request(missUrl, { headers: { cookie } }));
    expect(missRes.status).toBe(404);
  });

  test('rejects a non-artifact key that would shadow a static asset (403)', async () => {
    const routes = createOriginalsRoutes({ jwtSecret: JWT, store: tmpStore() });
    const shadow = (key: string) => {
      const url = new URL(`http://h/api/originals/host/${encodeURIComponent(key)}`);
      return routes.hostPut(
        new Request(url, { method: 'PUT', headers: { 'content-type': 'application/javascript', cookie: cookieFor('sub-1') }, body: 'alert(1)' }),
        url,
        '1.1.1.1'
      );
    };
    expect((await shadow('magby.originals.build/assets/app-abc123.js')).status).toBe(403);
    expect((await shadow('magby.originals.build/index.html')).status).toBe(403);
    // A bare 'resources/<name>' whose name isn't a multibase is refused too.
    expect((await shadow('magby.originals.build/assets/resources/evil.js')).status).toBe(403);
    // But real did:webvh artifacts are allowed.
    expect((await shadow('magby.originals.build/user-sub-1/did.jsonl')).status).toBe(200);
    expect((await shadow('magby.originals.build/ueibabc/resources/uJZtLeUr')).status).toBe(200);
  });

  test('rejects an oversized upload by Content-Length (413)', async () => {
    const routes = createOriginalsRoutes({ jwtSecret: JWT, store: tmpStore() });
    const url = new URL(`http://h/api/originals/host/${encodeURIComponent('h/user-sub-1/did.jsonl')}`);
    const res = await routes.hostPut(
      new Request(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/jsonl', cookie: cookieFor('sub-1') },
        body: 'x'.repeat(9 * 1024 * 1024), // > 8 MiB cap ⇒ Content-Length trips the guard
      }),
      url,
      '1.1.1.1'
    );
    expect(res.status).toBe(413);
  });

  test('a second user cannot overwrite the first user’s object (403)', async () => {
    const routes = createOriginalsRoutes({ jwtSecret: JWT, store: tmpStore() });
    const key = 'demo.example.com/user-sub-1/abc/did.jsonl';
    const url = new URL(`http://h/api/originals/host/${encodeURIComponent(key)}`);
    const put = (sub: string) =>
      routes.hostPut(
        new Request(url, { method: 'PUT', headers: { 'content-type': 'application/jsonl', cookie: cookieFor(sub) }, body: '{}' }),
        url,
        '1.1.1.1'
      );
    expect((await put('sub-1')).status).toBe(200); // sub-1 owns it
    expect((await put('sub-2')).status).toBe(403); // sub-2 is refused
    expect((await put('sub-1')).status).toBe(200); // owner may re-write
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

    const key = 'demo.example.com/user-sub-1/abc/did.jsonl';
    const putRes = await fetchFn(
      new Request(`http://demo.local/api/originals/host/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/jsonl', cookie: cookieFor('sub-1') },
        body: '{"v":1}',
      })
    );
    expect(putRes.status).toBe(200);

    // Anyone GETting the resolver URL gets the durable object via the serve fallback.
    const getRes = await fetchFn(new Request('http://demo.example.com/user-sub-1/abc/did.jsonl'));
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
