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
import { createHash } from 'node:crypto';
import { localSigner } from '@originals/vh/crypto';
import { appendEntry, createLog, createWitnessProof, serializeLog, signWith } from '@originals/vh/log';

/** A real did:vh signer DID log of `versions` entries, and the directory hex it lives under. */
async function signerLog(versions = 2, opts: { witnessed?: boolean } = {}) {
  const witness = localSigner('Ed25519', crypto.getRandomValues(new Uint8Array(32)));
  const update = localSigner('Ed25519', crypto.getRandomValues(new Uint8Array(32)));
  const author = localSigner('Ed25519', crypto.getRandomValues(new Uint8Array(32)));
  const sign = signWith(update, { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${update.publicKeyMultibase}#${update.publicKeyMultibase}` });
  const doc = (id: string) => ({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id,
    verificationMethod: [{ id: `${id}#k`, type: 'Multikey', controller: id, publicKeyMultibase: author.publicKeyMultibase }],
    assertionMethod: [`${id}#k`],
  });
  const t = Date.now() - 60_000;
  const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const entries = [await createLog({ versionTime: iso(t), parameters: { method: 'did:vh:1.0', scid: '{SCID}', updateKeys: [update.publicKeyMultibase], ...(opts.witnessed ? { witness: { threshold: 1, witnesses: [{ id: `did:key:${witness.publicKeyMultibase}` }] } } : {}) }, state: doc('did:vh:{SCID}'), sign })];
  const did = entries[0].state.id as string;
  for (let i = 1; i < versions; i++) entries.push(await appendEntry(entries[i - 1], { versionTime: iso(t + i * 1000), parameters: {}, state: { ...doc(did), alsoKnownAs: [`urn:v${i}`] }, sign }));
  const logs = entries.map((_, i) => serializeLog(entries.slice(0, i + 1)));
  // did:webvh 1.0 pruning: a controller SHOULD keep only the latest proof per witness, which approves every earlier entry too.
  const proofs = await Promise.all(entries.map((e) => createWitnessProof(witness, e.versionId)));
  const pruned = entries.map((e, i) => JSON.stringify([{ versionId: e.versionId, proof: [proofs[i]] }]));
  const full = entries.map((_, i) => JSON.stringify(entries.slice(0, i + 1).map((e, j) => ({ versionId: e.versionId, proof: [proofs[j]] }))));
  return { did, hex: createHash('sha256').update(did).digest('hex'), logs, witness: { pruned, full } };
}

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

  test('C12-84: a resource is served with the media type its asset log declares, isolated, whatever the uploader claimed (P9.7)', async () => {
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

  test('a key that decodes again into another namespace is refused', async () => {
    const { put } = setup();
    // %2F survives the route's decode and would become "/" in the store's.
    expect((await put(`demo.example.com%2Fuser-sub-2/user-sub-1/${NAME}/did.jsonl`, '{}')).status).toBe(403);
    expect((await put(`demo.example.com/user-sub-1/${NAME}%2Fdid.jsonl`, '{}')).status).toBe(403);
    for (const host of ['..', '.', 'a..b', '-x.com', 'a b.com', 'a\\b']) {
      expect((await put(`${host}/user-sub-1/${NAME}/did.jsonl`, '{}')).status, host).toBe(403);
    }
    expect((await put(`localhost:8080/user-sub-1/${NAME}/did.jsonl`, '{}')).status).toBe(200);
  });

  test('a declared media type that is not a bare type/subtype is not served', async () => {
    for (const mediaType of ['text/html\r\nx-evil: 1', 'image/svg+xml; charset=utf-8', 'svg', '']) {
      // A fresh host each time: an asset log can only be extended, never replaced.
      const { put } = setup();
      const bad = `${JSON.stringify({ versionId: '1-x', state: { asset: { resources: [{ id: 'a', mediaType, size: bytes.length, digest }] } } })}\n`;
      expect((await put(`${base}/asset/did.jsonl`, bad)).status).toBe(200);
      expect((await put(`${base}/resources/${digest}`, bytes)).status, JSON.stringify(mediaType)).toBe(409);
    }
  });

  test('logs and evidence files get the server\'s content types', async () => {
    const { fetchFn, put } = setup();
    await put(`${base}/asset/did.jsonl`, log);
    await put(`${base}/originals-evidence.json`, '{}');
    expect((await fetchFn(new Request(`http://${base}/asset/did.jsonl`))).headers.get('content-type')).toBe('application/jsonl');
    expect((await fetchFn(new Request(`http://${base}/originals-evidence.json`))).headers.get('content-type')).toBe('application/json');
  });
});

describe('hosted PUT bounds and signer DID logs (#965 review R4, C2)', () => {
  const NAME = 'o-9xKpQ2mN4vR7tW1z';
  const base = `demo.example.com/user-sub-1/${NAME}/originals`;
  const authorDir = `${base}/authors/${'a'.repeat(64)}`;

  function setup() {
    const store = tmpStore();
    const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
    const fetchFn = buildFetch({ apiRoutes: null, hostStore: noopHostStore(), distDir: '/nonexistent/', originals });
    const put = (key: string, body: BodyInit) =>
      fetchFn(new Request(`http://demo.local/api/originals/host/${encodeURIComponent(key)}`, { method: 'PUT', headers: { cookie: cookieFor('sub-1') }, body }));
    const get = async (key: string) => (await fetchFn(new Request(`http://${key}`)))?.text();
    return { originals, store, put, get };
  }

  test('a chunked body with no Content-Length is refused once it passes the cap, without reading it all', async () => {
    const { originals } = setup();
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled++ < 60) c.enqueue(chunk);
        else c.close();
      },
    });
    const url = new URL(`http://h/api/originals/host/${encodeURIComponent('demo.example.com/user-sub-1/did.jsonl')}`);
    const req = new Request(url, { method: 'PUT', headers: { cookie: cookieFor('sub-1') }, body, duplex: 'half' } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull();
    const res = await originals.hostPut(req, url, '1.1.1.1');
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(20);
  });

  test('the cap counts bytes, not characters', async () => {
    const { originals } = setup();
    // 3 million three-byte characters: 9 MB, past the 8 MiB cap, though under it in string length.
    const text = '€'.repeat(3_000_000);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    const url = new URL(`http://h/api/originals/host/${encodeURIComponent('demo.example.com/user-sub-1/did.jsonl')}`);
    const res = await originals.hostPut(new Request(url, { method: 'PUT', headers: { cookie: cookieFor('sub-1') }, body, duplex: 'half' } as RequestInit), url, '1.1.1.1');
    expect(res.status).toBe(413);
  });

  test('a signer DID log only grows: a PUT that does not extend the stored log is a 409 (P7.8)', async () => {
    const { put, get } = setup();
    const { hex, logs } = await signerLog(2);
    const [v1, v2] = logs;
    const dir = `${base}/authors/${hex}`;
    expect((await put(`${dir}/did.jsonl`, v1)).status).toBe(200);
    expect((await put(`${dir}/did.jsonl`, v2)).status).toBe(200);
    expect((await put(`${dir}/did.jsonl`, v2)).status).toBe(200); // a retry of the same log
    const rollBack = await put(`${dir}/did.jsonl`, v1);
    expect(rollBack.status).toBe(409);
    expect(await rollBack.json()).toMatchObject({ error: 'identity_log_not_extending' });
    const other = await signerLog(1);
    expect((await put(`${dir}/did.jsonl`, other.logs[0])).status).toBe(422); // another DID's log, in this DID's directory
    expect(await get(`${dir}/did.jsonl`)).toBe(v2);
  });

  test('#965 review r2 #6: a signer DID log must verify; junk appended is refused, and a stored log that does not verify is repaired by a verified one', async () => {
    const { store, put, get } = setup();
    const { hex, logs } = await signerLog(3);
    const [v1, v2, v3] = logs;
    const dir = `${base}/authors/${hex}`;
    expect((await put(`${dir}/did.jsonl`, v1)).status).toBe(200);
    // Bytes that extend the stored log but do not verify are refused, so they cannot block a later save.
    const junk = await put(`${dir}/did.jsonl`, `${v1}{"junk":1}\n`);
    expect(junk.status).toBe(422);
    expect(await junk.json()).toMatchObject({ error: 'identity_log_invalid' });
    expect((await put(`${dir}/did.jsonl`, 'not a log')).status).toBe(422);
    expect(await get(`${dir}/did.jsonl`)).toBe(v1);
    expect((await put(`${dir}/did.jsonl`, v2)).status).toBe(200);
    // A stored log poisoned before this rule (junk after its verified prefix) is replaced by a verified extension.
    store.saveBytes('sub-1', `${dir}/did.jsonl`, new TextEncoder().encode(`${v2}{"junk":1}\n`), 'application/jsonl');
    expect((await put(`${dir}/did.jsonl`, v1)).status).toBe(409); // still never a rollback of what verifies
    expect((await put(`${dir}/did.jsonl`, v3)).status).toBe(200);
    expect(await get(`${dir}/did.jsonl`)).toBe(v3);
    // A stored log that does not verify at all can be replaced by any verified log of the DID.
    store.saveBytes('sub-1', `${dir}/did.jsonl`, new TextEncoder().encode('{"junk":1}\n'), 'application/jsonl');
    expect((await put(`${dir}/did.jsonl`, v1)).status).toBe(200);
  });

  test('#965 r4 finding 3: a pruned did:webvh witness file is accepted when the stored log verifies with it; proofs compare canonically; a witness file never weakens the stored log (P7.8)', async () => {
    const { put, get } = setup();
    const { hex, logs, witness } = await signerLog(3, { witnessed: true });
    const dir = `${base}/authors/${hex}`;
    const w = `${dir}/did-witness.json`;
    expect((await put(w, witness.pruned[0])).status).toBe(200);
    expect((await put(`${dir}/did.jsonl`, logs[0])).status).toBe(200);
    // The next version's pruned file drops v1's proof. The stored log (v1) does not verify with it alone,
    // so the host keeps v1's proof too: the upload is merged, never a weakening.
    expect((await put(w, witness.pruned[1])).status).toBe(200);
    expect(JSON.parse((await get(w))!)).toEqual(JSON.parse(witness.full[1]));
    expect((await put(`${dir}/did.jsonl`, logs[1])).status).toBe(200);
    // Now the stored log verifies with the pruned file alone: it is stored as uploaded.
    expect((await put(w, witness.pruned[1])).status).toBe(200);
    expect(await get(w)).toBe(witness.pruned[1]);
    // The same proofs with members in another order are the same proofs (JCS).
    const reordered = JSON.stringify(JSON.parse(witness.pruned[1]).map((e: { versionId: string; proof: Record<string, unknown>[] }) => ({ proof: e.proof.map((p) => Object.fromEntries(Object.entries(p).reverse())), versionId: e.versionId })));
    expect((await put(w, reordered)).status).toBe(200);
    // A file that alone would leave v2 unwitnessed (a rollback of the stored log) never replaces the
    // stored proofs: what it adds is kept with them, and a file that adds nothing is refused.
    expect((await put(w, witness.pruned[0])).status).toBe(200);
    expect(JSON.parse((await get(w))!)).toEqual([...JSON.parse(witness.pruned[1]), ...JSON.parse(witness.pruned[0])]);
    const rollBack = await put(w, witness.pruned[0]);
    expect(rollBack.status).toBe(409);
    expect(await rollBack.json()).toMatchObject({ error: 'identity_witness_not_extending' });
    expect((await put(w, '[]')).status).toBe(409);
    expect((await put(w, witness.pruned[1])).status).toBe(200);
    // A malformed member would make the engine reject the whole file: refused.
    expect((await put(w, JSON.stringify([...JSON.parse(witness.pruned[1]), { versionId: 'x', proof: [], extra: 1 }]))).status).toBe(409);
    expect((await put(`${dir}/did.jsonl`, logs[2])).status).toBe(422); // v3 not witnessed by the stored file
    expect((await put(w, witness.pruned[2])).status).toBe(200);
    expect((await put(`${dir}/did.jsonl`, logs[2])).status).toBe(200);
    expect((await put(w, witness.pruned[2])).status).toBe(200);
    expect(await get(w)).toBe(witness.pruned[2]);
  });

  test('#965 r4 finding 3: with no stored log, a pruned witness file is kept with the stored proofs', async () => {
    const { put, get } = setup();
    const p = (wit: string, v: string) => ({ type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${wit}#${wit}`, proofPurpose: 'assertionMethod', proofValue: `z${v}` });
    const stored = [{ versionId: '1-Qa', proof: [p('zW1', 'a1'), p('zW2', 'a2')] }];
    const pruned = [{ versionId: '2-Qb', proof: [p('zW1', 'b1'), p('zW2', 'b2')] }];
    expect((await put(`${authorDir}/did-witness.json`, JSON.stringify(stored))).status).toBe(200);
    expect((await put(`${authorDir}/did-witness.json`, JSON.stringify(pruned))).status).toBe(200);
    expect(JSON.parse((await get(`${authorDir}/did-witness.json`))!)).toEqual([...stored, ...pruned]);
  });

  test('#965 r5 finding 3: a witness file nested deeper than the JSON depth limit is a structured 422, never a 500', async () => {
    const { put, get } = setup();
    const { hex, logs, witness } = await signerLog(2, { witnessed: true });
    const dir = `${base}/authors/${hex}`;
    const w = `${dir}/did-witness.json`;
    expect((await put(w, witness.pruned[0])).status).toBe(200);
    expect((await put(`${dir}/did.jsonl`, logs[0])).status).toBe(200);
    const full = JSON.parse(witness.full[1]) as Array<{ versionId: string; proof: unknown[] }>;
    const p0 = JSON.stringify(full[1].proof[0]).slice(0, -1);
    for (const n of [65, 50_000]) {
      // A superset of the stored proofs whose extra proof nests n levels: canonicalising it once overflowed the stack.
      const deep = '['.repeat(n) + ']'.repeat(n);
      const evil = `${JSON.stringify(full).slice(0, -1)},{"versionId":${JSON.stringify(full[1].versionId)},"proof":[${p0},"x":${deep}}]}]`;
      const res = await put(w, evil);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: 'identity_witness_invalid' });
    }
    expect(await get(w)).toBe(witness.pruned[0]);
    expect((await put(`${dir}/did.jsonl`, logs[0])).status).toBe(200);
  });

  test('a signer DID witness file only gains proofs: a PUT that drops one is a 409', async () => {
    const { put, get } = setup();
    const p1 = { versionId: '1-a', proof: [{ proofValue: 'z1' }] };
    const w1 = JSON.stringify([p1]);
    const w2 = JSON.stringify([{ ...p1, proof: [...p1.proof, { proofValue: 'z2' }] }, { versionId: '2-b', proof: [{ proofValue: 'z3' }] }]);
    expect((await put(`${authorDir}/did-witness.json`, w1)).status).toBe(200);
    expect((await put(`${authorDir}/did-witness.json`, w2)).status).toBe(200);
    expect((await put(`${authorDir}/did-witness.json`, w1)).status).toBe(409);
    expect((await put(`${authorDir}/did-witness.json`, '[]')).status).toBe(409);
    expect((await put(`${authorDir}/did-witness.json`, 'not json')).status).toBe(409);
    expect(await get(`${authorDir}/did-witness.json`)).toBe(w2);
  });
});

describe('a hosted asset log changes only through the verifying submit route (P6.7)', () => {
  const base = 'demo.example.com/user-sub-1/o-9xKpQ2mN4vR7tW1z/originals';
  test('an upload creates the asset log or repeats it; one that rolls it back or extends it is refused', async () => {
    const store = tmpStore();
    const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
    const fetchFn = buildFetch({ apiRoutes: null, hostStore: noopHostStore(), distDir: '/nonexistent/', originals });
    const put = (body: string) =>
      fetchFn(new Request(`http://demo.local/api/originals/host/${encodeURIComponent(`${base}/asset/did.jsonl`)}`, { method: 'PUT', headers: { cookie: cookieFor('sub-1') }, body }));
    expect((await put('{"versionId":"1-a"}\n{"versionId":"2-b"}\n')).status).toBe(200);
    expect((await put('{"versionId":"1-a"}\n{"versionId":"2-b"}\n')).status).toBe(200);
    const rollback = await put('{"versionId":"1-a"}\n');
    expect(rollback.status).toBe(409);
    expect(await rollback.json()).toEqual({ error: 'asset_log_changes_through_submit' });
    // Extending it is a save, which goes through the submit route (shared-host PR review C4).
    expect((await put('{"versionId":"1-a"}\n{"versionId":"2-b"}\n{"versionId":"3-c"}\n')).status).toBe(409);
  });

  test('a submission needs a signed-in caller and a well-formed site key', async () => {
    const store = tmpStore();
    const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
    const fetchFn = buildFetch({ apiRoutes: null, hostStore: noopHostStore(), distDir: '/nonexistent/', originals });
    const post = (key: string, cookie?: string, method = 'POST') =>
      fetchFn(new Request(`http://demo.local/api/originals/submit/${encodeURIComponent(key)}`, { method, headers: cookie ? { cookie } : {}, body: method === 'POST' ? '{}' : undefined }));
    expect((await post('demo.example.com/user-sub-1/o-9xKpQ2mN4vR7tW1z')).status).toBe(401);
    expect((await post('demo.example.com/user-sub-1/o-9xKpQ2mN4vR7tW1z', cookieFor('sub-1'), 'PUT')).status).toBe(405);
    for (const key of ['demo.example.com/user-sub-1', 'demo.example.com/user-sub-1/o-9xKpQ2mN4vR7tW1z/extra', '../x/o-9xKpQ2mN4vR7tW1z', 'demo.example.com/user-sub-1/not-a-name']) {
      expect((await post(key, cookieFor('sub-1'))).status, key).toBe(400);
    }
    expect((await post('demo.example.com/user-sub-1/o-9xKpQ2mN4vR7tW1z', cookieFor('sub-1'))).status).toBe(400);
  });
});
