/**
 * The interop contract for `https://originals.build/context`.
 *
 * Every credential the SDK issues names that URL, so a conformant verifier's
 * document loader fetches it. Before this route it got the SPA's HTML under
 * `text/html` and refused the credential; our own stack was blind to it,
 * because the SDK's loader serves a bundled copy and never makes the request.
 *
 * These cases therefore assert the two things a foreign loader actually
 * checks — the media type, and that the body is parseable JSON-LD — plus the
 * one thing that keeps them honest over time: that the served document is the
 * same one the SDK verifies against.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFetch } from '../app';
import { json } from '../router';
import { createWebvhHostStore, shadowsReservedPath } from '../webvh-host';

// Read from disk rather than importing it: the route imports this same file,
// so an import here would compare it to itself. Reading the SDK's copy
// independently is what catches the realistic regression — someone
// "simplifying" the route by pasting a local copy of the context, which then
// silently stops tracking the document credentials are verified against.
const SDK_CONTEXT_FILE = join(
  import.meta.dir,
  '../../../../packages/sdk/src/contexts/originals.json'
);
const sdkContext = JSON.parse(readFileSync(SDK_CONTEXT_FILE, 'utf8'));

const noopHostStore = {
  async handlePut() {
    return json({ error: 'not_implemented' }, 501);
  },
  read() {
    return json({ error: 'not_found' }, 404);
  },
  serve() {
    return null as Response | null;
  },
};

let distDir: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'landing-context-'));
  // The SPA fallback this route has to win against: without the /context
  // route, every case below would see this document instead.
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
  distDir = dir + '/';
});

afterAll(() => rmSync(distDir, { recursive: true, force: true }));

const fetchIt = () =>
  buildFetch({ apiRoutes: null, hostStore: noopHostStore, distDir, trustedProxyHops: 0 });

describe('GET /context', () => {
  test('is served as application/ld+json, not the SPA', async () => {
    const res = await fetchIt()(new Request('http://originals.build/context'));
    expect(res.status).toBe(200);
    // The media type is the whole point: a JSON-LD loader dispatches on it and
    // refuses text/html outright.
    expect(res.headers.get('content-type')).toBe('application/ld+json; charset=utf-8');
  });

  test('parses as JSON and declares an @context', async () => {
    const res = await fetchIt()(new Request('http://originals.build/context'));
    const body = await res.text();
    expect(body).not.toContain('<!doctype html>');
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed['@context']).toBeDefined();
    expect(typeof parsed['@context']).toBe('object');
  });

  test('serves exactly the context the SDK verifies credentials against', async () => {
    // The drift guard. If someone edits the bundled context and this route
    // keeps serving a stale copy, credentials verify in-repo and fail
    // everywhere else — the precise failure this route exists to end.
    const res = await fetchIt()(new Request('http://originals.build/context'));
    const served = JSON.parse(await res.text());
    expect(served).toEqual(sdkContext);
  });

  test('is fetchable cross-origin by a browser-based verifier', async () => {
    const res = await fetchIt()(new Request('http://originals.build/context'));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('answers the CORS preflight a negotiating loader may send', async () => {
    const res = await fetchIt()(new Request('http://originals.build/context', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('HEAD carries the same media type', async () => {
    const res = await fetchIt()(new Request('http://originals.build/context', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/ld+json; charset=utf-8');
  });

  test('rejects a write rather than falling through to the SPA', async () => {
    const res = await fetchIt()(new Request('http://originals.build/context', { method: 'POST' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
  });

  test('answers on the network-scoped hosts too, with the same document', async () => {
    // The pichu/cleffa/magby context URLs in packages/sdk/src/types/network.ts
    // are the same path on other origins, and the SDK's loader maps all four to
    // one bundled document — so the route must be host-agnostic.
    for (const host of ['pichu.originals.build', 'cleffa.originals.build', 'magby.originals.build']) {
      const res = await fetchIt()(new Request(`http://${host}/context`));
      expect(res.headers.get('content-type')).toBe('application/ld+json; charset=utf-8');
      expect(JSON.parse(await res.text())).toEqual(sdkContext);
    }
  });
});

/**
 * The canonical context cannot be shadowed by hosted content.
 *
 * `/api/host/*` is unauthenticated with client-chosen keys, and the store looks
 * a request up as `${url.host}${url.pathname}` — so `originals.build/context`
 * would intercept this route. The store tolerates anonymous writes because
 * did:webvh logs are self-certifying and fail verification if tampered with. A
 * JSON-LD context has no such property: it defines what every credential MEANS,
 * so whoever serves it controls how external verifiers read all of them.
 *
 * Two independent guarantees, asserted separately so neither can rot into the
 * other: the route resolves first, AND the key never enters the store.
 */
describe('/context outranks anonymous hosted content', () => {
  // A store that answers EVERYTHING, standing in for an attacker who has
  // successfully stored the shadowing key.
  const hostileStore = {
    async handlePut() {
      return json({ error: 'not_implemented' }, 501);
    },
    read() {
      return json({ error: 'not_found' }, 404);
    },
    serve() {
      return new Response('{"@context":{"OWNED":"attacker"}}', {
        status: 200,
        headers: { 'content-type': 'application/ld+json' },
      });
    },
  };

  test('the canonical document wins even when the store would answer', async () => {
    const fetchFn = buildFetch({
      apiRoutes: null,
      hostStore: hostileStore,
      distDir,
      trustedProxyHops: 0,
    });
    const res = await fetchFn(new Request('http://originals.build/context'));
    const body = await res.text();

    expect(body).not.toContain('OWNED');
    expect(JSON.parse(body)).toEqual(sdkContext);
  });

  test('hosted routes still work — only the reserved path is taken', async () => {
    // The guard must not cost the store its actual job.
    const fetchFn = buildFetch({
      apiRoutes: null,
      hostStore: hostileStore,
      distDir,
      trustedProxyHops: 0,
    });
    const res = await fetchFn(new Request('http://originals.build/alice/did.jsonl'));
    expect(await res.text()).toContain('OWNED');
  });
});

describe('the host store refuses the shadowing key outright', () => {
  test('a PUT that would shadow /context is rejected', async () => {
    const store = createWebvhHostStore();
    const res = await store.handlePut(
      new Request('http://x/api/host/originals.build/context', { method: 'PUT', body: 'x' }),
      new URL('http://x/api/host/originals.build/context'),
      '1.2.3.4'
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'reserved_key' });
  });

  test('percent-encoding does not get past it — the decoded key is checked', async () => {
    const store = createWebvhHostStore();
    const path = '/api/host/originals.build/%63ontext';
    const res = await store.handlePut(
      new Request(`http://x${path}`, { method: 'PUT', body: 'x' }),
      new URL(`http://x${path}`),
      '1.2.3.4'
    );
    expect(res.status).toBe(403);
  });

  test('only an exact match is reserved; ordinary keys still store', async () => {
    const store = createWebvhHostStore();
    for (const key of ['originals.build/contextual', 'originals.build/context/x']) {
      const res = await store.handlePut(
        new Request(`http://x/api/host/${key}`, { method: 'PUT', body: 'x' }),
        new URL(`http://x/api/host/${key}`),
        '1.2.3.4'
      );
      expect(res.status).toBe(200);
    }
  });
});

describe('shadowsReservedPath', () => {
  test('matches the path after the host, and nothing else', () => {
    expect(shadowsReservedPath('originals.build/context')).toBe(true);
    expect(shadowsReservedPath('any.host/context')).toBe(true);
    expect(shadowsReservedPath('originals.build/contextual')).toBe(false);
    expect(shadowsReservedPath('originals.build/context/x')).toBe(false);
    expect(shadowsReservedPath('originals.build/a/context')).toBe(false);
    // A bare key with no host segment addresses nothing servable.
    expect(shadowsReservedPath('context')).toBe(false);
  });
});
