import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import { createOriginalsStore } from '../originals-store';
import { createOriginalsRoutes } from '../originals-routes';
import { buildFetch } from '../app';
import { resourceDigest } from '@originals/vh/originals';

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
    const key = 'demo.example.com/user-sub-1/o-9xKpQ2mN4vR7tW1z/did.jsonl';
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
    const missUrl = `http://demo.local/api/originals/host/${encodeURIComponent('demo.example.com/user-sub-1/o-111111111111111a/did.jsonl')}`;
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
    // CEL-era shapes and anything outside the hosted layout are refused.
    expect((await shadow('magby.originals.build/assets/resources/evil.js')).status).toBe(403);
    expect((await shadow('cel/uEiCGpqek6fgu3Ut-2k4Pj8KTiobAgA6PiAHuJ-Fw0dcGDA.json')).status).toBe(403);
    expect((await shadow('magby.originals.build/ueibabc/resources/uJZtLeUr')).status).toBe(403);
    expect((await shadow('magby.originals.build/user-sub-1/o-9xKpQ2mN4vR7tW1z/cel.json')).status).toBe(403);
    expect((await shadow('magby.originals.build/user-sub-1/o-9xKpQ2mN4vR7tW1z/originals/../../index.html')).status).toBe(403);
    // The hosted layout in the caller's own namespace is allowed.
    expect((await shadow('magby.originals.build/user-sub-1/did.jsonl')).status).toBe(200);
    expect((await shadow('magby.originals.build/user-sub-1/o-9xKpQ2mN4vR7tW1z/did.jsonl')).status).toBe(200);
    expect((await shadow('magby.originals.build/user-sub-1/o-9xKpQ2mN4vR7tW1z/originals/originals-evidence.json')).status).toBe(200);
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
    const key = 'demo.example.com/user-sub-1/o-9xKpQ2mN4vR7tW1z/did.jsonl';
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

  test('orphaned bytes with no owner marker are refused with 409, not silently claimed (#690)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'originals-routes-'));
    const store = createOriginalsStore({ dataDir });
    const routes = createOriginalsRoutes({ jwtSecret: JWT, store });
    // Every hosted key is inside its author's namespace; the owner sidecar still
    // guards against claiming bytes whose ownership was never recorded (#690).
    const key = 'demo.example.com/user-sub-1/o-9xKpQ2mN4vR7tW1z/originals/originals-evidence.json';
    // Simulate the crash window this store's write ordering closes: resource
    // bytes on disk with no `.owner` sidecar (store-level coverage of the
    // same state lives in originals-store.test.ts). This must fail closed at
    // the HTTP layer too, for the original owner and any other caller.
    const path = join(dataDir, 'hosted', ...key.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'orphaned bytes, no .owner sidecar');

    const put = (sub: string) => {
      const url = new URL(`http://h/api/originals/host/${encodeURIComponent(key)}`);
      return routes.hostPut(
        new Request(url, { method: 'PUT', headers: { 'content-type': 'application/jsonl', cookie: cookieFor(sub) }, body: '{}' }),
        url,
        '1.1.1.1'
      );
    };
    expect((await put('sub-1')).status).toBe(409);
    expect((await put('sub-2')).status).toBe(403); // not sub-2's namespace at all
  });

  test('pre-squat blocked: cannot write another user’s namespace even when unclaimed (403)', async () => {
    const routes = createOriginalsRoutes({ jwtSecret: JWT, store: tmpStore() });
    // sub-2 targets sub-1's PREDICTABLE publisher path BEFORE sub-1 ever writes —
    // the owner sidecar alone wouldn't stop this (unclaimed key); the namespace
    // guard does.
    const key = 'demo.example.com/user-sub-1/did.jsonl';
    const url = new URL(`http://h/api/originals/host/${encodeURIComponent(key)}`);
    const res = await routes.hostPut(
      new Request(url, { method: 'PUT', headers: { 'content-type': 'application/jsonl', cookie: cookieFor('sub-2') }, body: '{}' }),
      url,
      '1.1.1.1'
    );
    expect(res.status).toBe(403); // forbidden_namespace
  });

  test('a malformed percent-encoded key is a clean 400, not a 500', async () => {
    const routes = createOriginalsRoutes({ jwtSecret: JWT, store: tmpStore() });
    // %GG is an invalid escape: the URL constructor accepts it, decodeURIComponent throws.
    const url = new URL('http://h/api/originals/host/demo.example.com/%GG/did.jsonl');
    const putRes = await routes.hostPut(
      new Request(url, { method: 'PUT', headers: { cookie: cookieFor('sub-1') }, body: '{}' }),
      url,
      '1.1.1.1'
    );
    expect(putRes.status).toBe(400);
    const getRes = await routes.hostGet(new Request(url, { headers: { cookie: cookieFor('sub-1') } }), url);
    expect(getRes.status).toBe(400);
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

  test('record accepts optional inscription fields and list returns them', async () => {
    const routes = createOriginalsRoutes({ jwtSecret: JWT, store: tmpStore() });
    const cookie = cookieFor('sub-1');
    const did = 'did:webvh:S:demo.example.com:studio:you:abc';
    const post = (body: unknown) =>
      routes.record(
        new Request('http://h/api/originals', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
        new URL('http://h/api/originals')
      );
    expect((await post({ did, title: 'Piece', resourceHash: 'deadbeef' })).status).toBe(200);
    // Post-inscribe enrichment merges onto the same row.
    const rec2 = await post({
      did,
      title: 'Piece',
      resourceHash: 'deadbeef',
      btcoDid: 'did:btco:456',
      inscriptionId: `${'r'.repeat(64)}i0`,
      commitTxId: 'c'.repeat(64),
      revealTxId: 'r'.repeat(64),
      satoshi: '456',
      status: 'pending',
    });
    expect(rec2.status).toBe(200);

    const list = await routes.list(
      new Request('http://h/api/originals', { headers: { cookie } }),
      new URL('http://h/api/originals')
    );
    const body = (await list.json()) as { originals: Array<Record<string, unknown>> };
    expect(body.originals).toHaveLength(1);
    expect(body.originals[0].btcoDid).toBe('did:btco:456');
    expect(body.originals[0].satoshi).toBe('456');
    expect(body.originals[0].inscriptionStatus).toBe('pending');

    // Malformed inscription fields are rejected, not silently persisted.
    expect((await post({ did, title: 'x', resourceHash: 'y', status: 'nonsense' })).status).toBe(400);
    expect((await post({ did, title: 'x', resourceHash: 'y', satoshi: 42 })).status).toBe(400);
  });

  test('PUT host stores durably and buildFetch serves it at the resolver URL', async () => {
    const store = tmpStore();
    const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
    const fetchFn = buildFetch({ apiRoutes: null, hostStore: noopHostStore(), distDir: '/nonexistent/', originals });

    const key = 'demo.example.com/user-sub-1/o-9xKpQ2mN4vR7tW1z/did.jsonl';
    const putRes = await fetchFn(
      new Request(`http://demo.local/api/originals/host/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/jsonl', cookie: cookieFor('sub-1') },
        body: '{"v":1}',
      })
    );
    expect(putRes.status).toBe(200);

    // Anyone GETting the resolver URL gets the durable object via the serve fallback.
    const getRes = await fetchFn(new Request('http://demo.example.com/user-sub-1/o-9xKpQ2mN4vR7tW1z/did.jsonl'));
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


describe('hosted Original layout (plan 011, PR 8)', () => {
  const NAME = 'o-9xKpQ2mN4vR7tW1z';
  const base = `demo.example.com/user-sub-1/${NAME}/originals`;
  const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const digest = resourceDigest(bytes);
  const log = `${JSON.stringify({ versionId: '1-x', state: { asset: { resources: [{ id: 'artwork.svg', mediaType: 'image/svg+xml', size: bytes.length, digest }] } } })}\n`;

  function setup() {
    const store = tmpStore();
    const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
    const fetchFn = buildFetch({ apiRoutes: null, hostStore: noopHostStore(), distDir: '/nonexistent/', originals });
    const put = (key: string, body: BodyInit, contentType = 'text/html') =>
      fetchFn(new Request(`http://demo.local/api/originals/host/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'content-type': contentType, cookie: cookieFor('sub-1') }, body }));
    return { fetchFn, put };
  }

  test('a resource must be listed in the uploaded asset log and match its digest', async () => {
    const { put } = setup();
    expect((await put(`${base}/resources/${digest}`, bytes)).status).toBe(409); // log not uploaded yet
    expect((await put(`${base}/asset/did.jsonl`, log)).status).toBe(200);
    expect((await put(`${base}/resources/${digest}`, new TextEncoder().encode('other bytes'))).status).toBe(422);
    const unlisted = resourceDigest(new TextEncoder().encode('not in the log'));
    expect((await put(`${base}/resources/${unlisted}`, new TextEncoder().encode('not in the log'))).status).toBe(409);
    expect((await put(`${base}/resources/${digest}`, bytes)).status).toBe(200);
  });

  test('C12-84: a resource is served with its signed media type, isolated, whatever the uploader claimed (P9.7)', async () => {
    const { fetchFn, put } = setup();
    await put(`${base}/asset/did.jsonl`, log);
    await put(`${base}/resources/${digest}`, bytes, 'text/html');
    const res = await fetchFn(new Request(`http://${base}/resources/${digest}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-disposition')).toBe('attachment');
  });

  test('logs and evidence files get the server\'s content types', async () => {
    const { fetchFn, put } = setup();
    await put(`${base}/asset/did.jsonl`, log);
    await put(`${base}/originals-evidence.json`, '{}');
    expect((await fetchFn(new Request(`http://${base}/asset/did.jsonl`))).headers.get('content-type')).toBe('application/jsonl');
    expect((await fetchFn(new Request(`http://${base}/originals-evidence.json`))).headers.get('content-type')).toBe('application/json');
  });
});
