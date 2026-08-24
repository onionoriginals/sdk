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
