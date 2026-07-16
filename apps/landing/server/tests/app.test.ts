import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFetch } from '../app';
import { buildStubRoutes } from '../index';
import { json, type Handler } from '../router';

// A no-op host store matching the WebvhHostStore surface buildFetch depends on.
const noopHostStore = {
  async handlePut() {
    return json({ error: 'not_implemented' }, 501);
  },
  serve() {
    return null as Response | null;
  },
};

let distDir: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'landing-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
  writeFileSync(join(dir, 'app.js'), 'console.log("asset")');
  distDir = dir + '/';
});

afterAll(() => rmSync(distDir, { recursive: true, force: true }));

function makeFetch(routes: Record<string, Handler>) {
  return buildFetch({ routes, hostStore: noopHostStore, distDir });
}

describe('unified server buildFetch', () => {
  test('serves a real static asset from dist', async () => {
    const res = await makeFetch(buildStubRoutes())(new Request('http://x/app.js'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('asset');
  });

  test('SPA fallback: unknown non-file path returns index.html', async () => {
    const res = await makeFetch(buildStubRoutes())(new Request('http://x/some/client/route'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('spa');
  });

  test('rejects path traversal', async () => {
    const res = await makeFetch(buildStubRoutes())(
      new Request('http://x/..%2f..%2fetc%2fpasswd')
    );
    expect(res.status).toBe(400);
  });

  test('GET /api/health returns ok', async () => {
    const res = await makeFetch(buildStubRoutes())(new Request('http://x/api/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('auth route returns 503 when unconfigured', async () => {
    const res = await makeFetch(buildStubRoutes())(
      new Request('http://x/api/auth/send-otp', { method: 'POST' })
    );
    expect(res.status).toBe(503);
  });

  test('POST /api/host/* is routed to the host store, not static', async () => {
    const res = await makeFetch(buildStubRoutes())(
      new Request('http://x/api/host/whatever', { method: 'PUT' })
    );
    expect(res.status).toBe(501); // noopHostStore.handlePut
  });

  test('host writes get the real socket IP (server.requestIP), not a client header', async () => {
    let seenIp: string | undefined;
    const recordingStore = {
      async handlePut(_req: Request, _url: URL, clientIp: string) {
        seenIp = clientIp;
        return json({ ok: true }, 200);
      },
      serve: () => null as Response | null,
    };
    const fetchFn = buildFetch({ routes: buildStubRoutes(), hostStore: recordingStore, distDir });
    const fakeServer = { requestIP: () => ({ address: '203.0.113.7' }) };
    await fetchFn(
      new Request('http://x/api/host/k', {
        method: 'PUT',
        headers: { 'x-forwarded-for': '9.9.9.9' }, // spoofed — must be ignored
      }),
      fakeServer
    );
    expect(seenIp).toBe('203.0.113.7');

    // No server object available → falls back to 'local', never the header.
    await fetchFn(
      new Request('http://x/api/host/k2', {
        method: 'PUT',
        headers: { 'x-forwarded-for': '9.9.9.9' },
      })
    );
    expect(seenIp).toBe('local');
  });
});
