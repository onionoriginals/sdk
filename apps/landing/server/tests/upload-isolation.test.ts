import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFetch } from '../app';
import { createWebvhHostStore } from '../webvh-host';
import type { OriginalsRoutes } from '../originals-routes';

// Capture before the repository test preload installs its per-test fetch spy.
const httpFetch = globalThis.fetch.bind(globalThis);

// Exercise the public HTTP seam with a harmless marker, including a module
// loaded by the real application document. No credentials or external hosts.
describe('anonymous upload isolation (#568)', () => {
  let distDir: string;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  const durable = new Map<string, string>();
  const marker = 'globalThis.uploadIsolationMarker = "anonymous";';

  beforeAll(() => {
    distDir = mkdtempSync(join(tmpdir(), 'upload-isolation-')) + '/';
    mkdirSync(join(distDir, 'assets'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>trusted</title><script type="module" src="/assets/app.js"></script>');
    writeFileSync(join(distDir, 'assets/app.js'), 'globalThis.uploadIsolationMarker = "trusted";');
    const originals: OriginalsRoutes = {
      hostPut: async () => new Response(null, { status: 401 }),
      hostGet: async () => new Response(null, { status: 401 }),
      record: () => new Response(null, { status: 401 }),
      list: () => new Response(null, { status: 401 }),
      serve: (url) => durable.has(url.pathname) ? new Response(durable.get(url.pathname)) : null,
    };
    server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: buildFetch({
        apiRoutes: { 'GET /api/health': () => Response.json({ trusted: true }) },
        hostStore: createWebvhHostStore(), originals, distDir, trustedProxyHops: 0,
      }),
    });
    origin = server.url.origin;
  });

  afterAll(() => {
    server.stop(true);
    rmSync(distDir, { recursive: true, force: true });
  });

  async function upload(path: string, body: string | Uint8Array = marker, contentType = 'application/javascript') {
    return httpFetch(`${origin}/api/host/${encodeURIComponent(new URL(origin).host + path)}`, {
      method: 'PUT', headers: { 'content-type': contentType }, body,
    });
  }

  test('an anonymous module upload cannot change the trusted module response', async () => {
    const before = await (await httpFetch(origin + '/assets/app.js')).text();
    const put = await upload('/assets/app.js');
    const after = await (await httpFetch(origin + '/assets/app.js')).text();
    expect(after).toBe(before);
    expect(put.status).toBe(403);
  });

  test('uploads cannot claim current or future application/API/context paths', async () => {
    for (const path of ['/index.html', '/', '/app.js', '/assets/future.js', '/api/health', '/api/future/did.jsonl', '/context']) {
      const before = await (await httpFetch(origin + path)).text();
      const put = await upload(path);
      expect(await (await httpFetch(origin + path)).text()).toBe(before);
      expect(put.status).toBe(403);
    }
  });

  test('an anonymous upload cannot replace a durable object', async () => {
    const path = '/asset-digest/did.jsonl';
    durable.set(path, 'durable creator log');
    await upload(path);
    expect(await (await httpFetch(origin + path)).text()).toBe('durable creator log');
  });

  test('a prior anonymous upload cannot shadow a later durable publication', async () => {
    const path = '/studio/you/did.jsonl';
    expect((await upload(path, 'anonymous old log', 'application/jsonl')).status).toBe(200);
    durable.set(path, 'durable new log');
    expect(await (await httpFetch(origin + path)).text()).toBe('durable new log');
    durable.delete(path);
  });

  test('anonymous writers cannot preclaim authenticated publisher namespaces', async () => {
    for (const path of ['/user-example/did.jsonl', '/published/accounts/alice/asset/did.jsonl', '/published/accounts/alice/asset/resources/uHash']) {
      expect((await upload(path)).status).toBe(403);
      expect((await httpFetch(origin + path)).status).toBe(404);
    }
  });

  test('encoded traversal and malformed keys cannot escape publication namespaces', async () => {
    for (const path of [
      '/published/anonymous/uAsset/../../assets/app.js',
      '/published/anonymous/uAsset/../did.jsonl',
      '/published/anonymous/uAsset/%2e%2e/did.jsonl',
      '/published/anonymous/uAsset\\..\\did.jsonl',
      '/assets/did.jsonl', '/arbitrary-app-path/did.jsonl',
    ]) {
      expect((await upload(path)).status).toBe(403);
    }
    for (const method of ['PUT', 'GET']) {
      const res = await httpFetch(origin + '/api/host/%GG', { method });
      expect(res.status).toBe(400);
    }
  });

  test('published URLs preserve the configured permanent DID host', async () => {
    const path = '/published/anonymous/uCanonical/did.jsonl';
    const hostStore = createWebvhHostStore();
    const fetchFn = buildFetch({ apiRoutes: null, hostStore, distDir, trustedProxyHops: 0, canonicalHost: 'originals.build' });
    const put = await fetchFn(new Request('https://originals.build/api/host/' + encodeURIComponent('originals.build' + path), {
      method: 'PUT', body: 'canonical DID log', headers: { 'content-type': 'application/jsonl' },
    }));
    expect(put.status).toBe(200);
    expect(await (await fetchFn(new Request('https://originals.build' + path))).text()).toBe('canonical DID log');
    const alias = await fetchFn(new Request('https://temporary.example' + path));
    expect(alias.status).toBe(301);
    expect(alias.headers.get('location')).toBe('https://originals.build' + path);
  });

  test('DID, CEL and binary resources keep their exact published URLs and bytes', async () => {
    for (const path of ['/published/anonymous/uAsset/did.jsonl', '/published/anonymous/uAsset/cel.json', '/.well-known/did.jsonl', '/studio/you/did.jsonl', '/studio/you/did.json', '/studio/you/cel.jsonl', '/studio/you/cel.json']) {
      const bytes = '{"published":true}\n';
      expect((await upload(path, bytes, 'application/jsonl')).status).toBe(200);
      expect(await (await httpFetch(origin + path)).text()).toBe(bytes);
    }
    const bytes = new Uint8Array([0, 255, 1, 128, 13, 10]);
    const path = '/published/anonymous/uAsset/resources/uHash';
    expect((await upload(path, bytes, 'image/png')).status).toBe(200);
    const res = await httpFetch(origin + path);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });
});
