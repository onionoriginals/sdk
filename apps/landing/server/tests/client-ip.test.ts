import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClientIp, trustedProxyHops } from '../client-ip';
import { buildFetch } from '../app';
import { json, type Handler } from '../router';

// A request as it arrives at the socket, with whatever chain the caller claims.
function req(xff?: string): Request {
  return new Request('http://x/api/host/k', {
    method: 'PUT',
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });
}
const peer = (address: string) => ({ requestIP: () => ({ address }) });

describe('trustedProxyHops', () => {
  test('unset means no proxy is trusted (0) — the fail-safe default', () => {
    expect(trustedProxyHops({})).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '' })).toBe(0);
  });

  test('reads a non-negative integer', () => {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '0' })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '1' })).toBe(1);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '2' })).toBe(2);
  });

  test('a malformed value degrades to 0, never to "trust the header"', () => {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: 'yes' })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '-1' })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '1.5' })).toBe(0);
  });
});

describe('resolveClientIp — hop count from the right-hand end', () => {
  test('a client-supplied forwarded prefix resolves to the proxy-appended address', () => {
    // The client sent "1.2.3.4"; the proxy appended the address it saw.
    const ip = resolveClientIp(req('1.2.3.4, 203.0.113.7'), peer('10.0.0.1'), { hops: 1 });
    expect(ip).toBe('203.0.113.7');
  });

  test('two clients prepending the SAME spoofed value still get separate identities', () => {
    const a = resolveClientIp(req('9.9.9.9, 203.0.113.7'), peer('10.0.0.1'), { hops: 1 });
    const b = resolveClientIp(req('9.9.9.9, 203.0.113.8'), peer('10.0.0.1'), { hops: 1 });
    expect(a).not.toBe(b);
  });

  test('with no proxy configured the header is ignored and the socket peer is used', () => {
    expect(resolveClientIp(req('9.9.9.9'), peer('203.0.113.7'), { hops: 0 })).toBe('203.0.113.7');
    // Rotating the header from a non-proxy source cannot mint a new identity.
    expect(resolveClientIp(req('8.8.8.8'), peer('203.0.113.7'), { hops: 0 })).toBe('203.0.113.7');
  });

  test('two socket peers get separate identities with no proxy configured', () => {
    expect(resolveClientIp(req(), peer('203.0.113.7'), { hops: 0 })).not.toBe(
      resolveClientIp(req(), peer('203.0.113.8'), { hops: 0 })
    );
  });

  test('a chain shorter than the trusted hop count falls back to the socket peer', () => {
    // hops=2 but only one entry: the trusted proxies did not append what we
    // expect, so nothing in the header is trustworthy.
    expect(resolveClientIp(req('9.9.9.9'), peer('10.0.0.1'), { hops: 2 })).toBe('10.0.0.1');
    expect(resolveClientIp(req(), peer('10.0.0.1'), { hops: 1 })).toBe('10.0.0.1');
    expect(resolveClientIp(req('   '), peer('10.0.0.1'), { hops: 1 })).toBe('10.0.0.1');
  });

  test('two trusted hops read the second entry from the right', () => {
    const ip = resolveClientIp(
      req('9.9.9.9, 203.0.113.7, 10.0.0.9'),
      peer('10.0.0.1'),
      { hops: 2 }
    );
    expect(ip).toBe('203.0.113.7');
  });

  test('no socket peer available degrades to a single shared identity, never the header', () => {
    expect(resolveClientIp(req('9.9.9.9'), undefined, { hops: 0 })).toBe('local');
    expect(resolveClientIp(req('9.9.9.9'), undefined, { hops: 2 })).toBe('local');
  });

  test('reads the hop count from the environment when not given one', () => {
    const ip = resolveClientIp(req('1.2.3.4, 203.0.113.7'), peer('10.0.0.1'), {
      env: { TRUSTED_PROXY_HOPS: '1' },
    });
    expect(ip).toBe('203.0.113.7');
    expect(resolveClientIp(req('1.2.3.4, 203.0.113.7'), peer('10.0.0.1'), { env: {} })).toBe(
      '10.0.0.1'
    );
  });
});

// The policy is only worth anything if the rate-limited routes actually key on
// it. These drive the real dispatch (buildFetch) rather than the helper.
describe('rate limits bind to the resolved client identity', () => {
  let distDir: string;
  {
    const dir = mkdtempSync(join(tmpdir(), 'landing-clientip-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
    distDir = dir + '/';
  }

  function recordingHostStore(seen: string[]) {
    return {
      async handlePut(_req: Request, _url: URL, clientIp: string) {
        seen.push(clientIp);
        return json({ ok: true });
      },
      read: () => json({ error: 'not_found' }, 404),
      serve: () => null as Response | null,
    };
  }

  test('host writes behind the proxy key on the proxy-appended address', async () => {
    const seen: string[] = [];
    const fetchFn = buildFetch({
      apiRoutes: null,
      hostStore: recordingHostStore(seen),
      distDir,
      trustedProxyHops: 1,
    });
    await fetchFn(
      new Request('http://x/api/host/k', {
        method: 'PUT',
        headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' },
      }),
      peer('10.0.0.1')
    );
    expect(seen).toEqual(['203.0.113.7']);
  });

  test('API routes receive the same identity the host store does', async () => {
    let seen: string | undefined;
    const apiRoutes: Record<string, Handler> = {
      'GET /api/health': (_req, _url, clientIp) => {
        seen = clientIp;
        return json({ status: 'ok' });
      },
    };
    const fetchFn = buildFetch({
      apiRoutes,
      hostStore: recordingHostStore([]),
      distDir,
      trustedProxyHops: 1,
    });
    await fetchFn(
      new Request('http://x/api/health', { headers: { 'x-forwarded-for': '9.9.9.9, 198.51.100.4' } }),
      peer('10.0.0.1')
    );
    expect(seen).toBe('198.51.100.4');
  });

  test('one client exceeding the host-write limit is throttled; another is not', async () => {
    const { createWebvhHostStore } = await import('../webvh-host');
    const hostStore = createWebvhHostStore({ limit: 2, windowMs: 60_000 });
    const fetchFn = buildFetch({ apiRoutes: null, hostStore, distDir, trustedProxyHops: 1 });
    const put = (client: string, key: string) =>
      fetchFn(
        new Request(`http://x/api/host/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/jsonl', 'x-forwarded-for': `9.9.9.9, ${client}` },
          body: 'x',
        }),
        peer('10.0.0.1')
      );

    expect((await put('203.0.113.7', 'a/1')).status).toBe(200);
    expect((await put('203.0.113.7', 'a/2')).status).toBe(200);
    expect((await put('203.0.113.7', 'a/3')).status).toBe(429);
    // A different client behind the same proxy still has its own bucket.
    expect((await put('203.0.113.8', 'b/1')).status).toBe(200);
  });

  test('rotating the forwarded header from a non-proxy source does not mint buckets', async () => {
    const { createWebvhHostStore } = await import('../webvh-host');
    const hostStore = createWebvhHostStore({ limit: 1, windowMs: 60_000 });
    // hops: 0 — nothing in front of this server, so the header is not evidence.
    const fetchFn = buildFetch({ apiRoutes: null, hostStore, distDir, trustedProxyHops: 0 });
    const put = (xff: string, key: string) =>
      fetchFn(
        new Request(`http://x/api/host/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/jsonl', 'x-forwarded-for': xff },
          body: 'x',
        }),
        peer('203.0.113.7')
      );
    expect((await put('1.1.1.1', 'a/1')).status).toBe(200);
    expect((await put('2.2.2.2', 'a/2')).status).toBe(429);
    expect((await put('3.3.3.3', 'a/3')).status).toBe(429);
  });
});
