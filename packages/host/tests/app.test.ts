import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFetch } from '../src/app.js';
import { json, type Handler } from '../src/router.js';

// A no-op host store matching the WebvhHostStore surface buildFetch depends on.
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

// A minimal "configured" API route map (auth present).
const configuredRoutes: Record<string, Handler> = {
  'GET /api/health': () => json({ status: 'ok' }),
  'POST /api/auth/send-otp': () => json({ ok: true }),
};

let distDir: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'landing-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
  writeFileSync(join(dir, 'app.js'), 'console.log("asset")');
  distDir = dir + '/';
});

afterAll(() => rmSync(distDir, { recursive: true, force: true }));

function makeFetch(apiRoutes: Record<string, Handler> | null) {
  // hops pinned so these cases never depend on an ambient TRUSTED_PROXY_HOPS.
  return buildFetch({ apiRoutes, hostStore: noopHostStore, distDir, trustedProxyHops: 0 });
}

describe('unified server buildFetch', () => {
  test('serves a real static asset from dist', async () => {
    const res = await makeFetch(null)(new Request('http://x/app.js'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('asset');
  });

  test('SPA fallback: unknown non-file path returns index.html', async () => {
    const res = await makeFetch(null)(new Request('http://x/some/client/route'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('spa');
  });

  test('rejects path traversal', async () => {
    const res = await makeFetch(null)(new Request('http://x/..%2f..%2fetc%2fpasswd'));
    expect(res.status).toBe(400);
  });

  test('GET /api/health returns ok when configured', async () => {
    const res = await makeFetch(configuredRoutes)(new Request('http://x/api/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('/api/* returns a clean JSON 404 when unconfigured (not SPA HTML)', async () => {
    const res = await makeFetch(null)(
      new Request('http://x/api/auth/send-otp', { method: 'POST' })
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('not configured');
  });

  test('POST /api/host/* is routed to the host store, not static (works without auth)', async () => {
    const res = await makeFetch(null)(
      new Request('http://x/api/host/whatever', { method: 'PUT' })
    );
    expect(res.status).toBe(501); // noopHostStore.handlePut
  });

  test('with no trusted proxy, host writes key on the socket IP and ignore the header', async () => {
    let seenIp: string | undefined;
    const recordingStore = {
      async handlePut(_req: Request, _url: URL, clientIp: string) {
        seenIp = clientIp;
        return json({ ok: true }, 200);
      },
      read: () => json({ error: 'not_found' }, 404),
      serve: () => null as Response | null,
    };
    const fetchFn = buildFetch({ apiRoutes: null, hostStore: recordingStore, distDir, trustedProxyHops: 0 });
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

// U6/8: the app document is the response that will hold a live signing
// credential, so it must arrive with a policy — and both serveStatic branches
// (real file, SPA fallback) must carry it, not just one.
describe('SPA document security headers', () => {
  const documentPaths = ['/', '/index.html', '/some/client/route'];

  for (const path of documentPaths) {
    test(`${path} carries a CSP that forbids third-party script origins`, async () => {
      const res = await makeFetch(null)(new Request('http://x' + path));
      expect(res.status).toBe(200);
      const csp = res.headers.get('content-security-policy');
      expect(csp).toBeTruthy();

      // Parse into directives so the assertions are about policy, not string order.
      const directives = new Map<string, string[]>(
        csp!.split(';').map((d) => {
          const [name, ...values] = d.trim().split(/\s+/);
          return [name.toLowerCase(), values];
        })
      );

      // Script may only come from this origin — no CDN, no 'unsafe-inline',
      // no 'unsafe-eval', no wildcard, and no fallback to a loose default-src.
      const script = directives.get('script-src');
      expect(script).toEqual(["'self'"]);
      expect(directives.get('default-src')).toEqual(["'self'"]);
      expect(directives.get('object-src')).toEqual(["'none'"]);
      expect(directives.get('base-uri')).toEqual(["'none'"]);
      expect(directives.get('frame-ancestors')).toEqual(["'none'"]);

      // The only permitted third-party network destination is Turnkey's API.
      const connect = directives.get('connect-src')!;
      expect(connect).toContain("'self'");
      expect(connect.filter((s) => s !== "'self'")).toEqual(['https://api.turnkey.com']);

      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-type')).toContain('text/html');
    });
  }

  test('no directive opens a blanket third-party origin', async () => {
    const res = await makeFetch(null)(new Request('http://x/'));
    const csp = res.headers.get('content-security-policy')!;
    const sources = csp
      .split(';')
      .flatMap((d) => d.trim().split(/\s+/).slice(1))
      .map((s) => s.toLowerCase());
    // Wildcards and bare schemes would readmit every CDN in one token.
    for (const wildcard of ['*', 'http:', 'https:', "'unsafe-eval'", "'unsafe-inline'"]) {
      expect(sources).not.toContain(wildcard);
    }
    // data: is allowed only where the bundle needs it (inline woff/svg), never
    // as a script source.
    expect(csp).toContain("script-src 'self'");
    for (const directive of csp.split(';').map((d) => d.trim())) {
      if (directive.includes('data:')) {
        expect(['img-src', 'font-src']).toContain(directive.split(/\s+/)[0]);
      }
      if (directive.includes('blob:')) {
        expect(directive.split(/\s+/)[0]).toBe('img-src');
      }
    }
  });

  /**
   * SEC-1 — HSTS is the backstop under the auth cookie. The 7-day JWT gates
   * every money route, and one plaintext request (a typed http:// URL, a stale
   * bookmark) is all an interception needs; a browser that has seen this header
   * never makes that request.
   */
  for (const path of documentPaths) {
    test(`${path} carries HSTS for a year, including subdomains`, async () => {
      const res = await makeFetch(null)(new Request('http://x' + path));
      const hsts = res.headers.get('strict-transport-security');
      expect(hsts).toBeTruthy();
      const maxAge = Number(/max-age=(\d+)/.exec(hsts!)?.[1]);
      expect(maxAge).toBeGreaterThanOrEqual(31536000);
      expect(hsts!.toLowerCase()).toContain('includesubdomains');
      // `preload` is a submission an operator makes deliberately — and is
      // effectively irreversible — so it is not a header default here.
      expect(hsts!.toLowerCase()).not.toContain('preload');
    });
  }

  test('non-document static assets are not given the document policy', async () => {
    const res = await makeFetch(null)(new Request('http://x/app.js'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});

/**
 * Canonical-host redirect (#529). A visitor who lands on the Railway-generated
 * hostname would otherwise mint did:webvh identifiers pinned to it, permanently.
 * Document requests bounce to the canonical host; API requests never do — a
 * redirected PUT would break publishing, and platform probes must not chase a
 * 301 to reach a healthy process.
 */
describe('canonical host redirect', () => {
  const canonical = (host?: string) =>
    buildFetch({
      apiRoutes: configuredRoutes,
      hostStore: noopHostStore,
      distDir,
      trustedProxyHops: 0,
      canonicalHost: host,
    });

  test('a document GET on a non-canonical host 301s to the canonical one', async () => {
    const res = await canonical('originals.build')(new Request('https://x.up.railway.app/some/page'));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://originals.build/some/page');
  });

  test('the query string survives the redirect', async () => {
    const res = await canonical('originals.build')(
      new Request('https://x.up.railway.app/verify?did=did%3Awebvh%3Aabc&x=1')
    );
    expect(res.headers.get('location')).toBe('https://originals.build/verify?did=did%3Awebvh%3Aabc&x=1');
  });

  test('the canonical host itself is served, not redirected', async () => {
    const res = await canonical('originals.build')(new Request('https://originals.build/app.js'));
    expect(res.status).toBe(200);
  });

  test('no canonical host configured means no redirect — dev and tests are unaffected', async () => {
    const res = await canonical(undefined)(new Request('http://localhost:3000/some/page'));
    expect(res.status).toBe(200);
  });

  test('/api/* is never redirected: a bounced PUT would break publishing', async () => {
    const res = await canonical('originals.build')(
      new Request('https://x.up.railway.app/api/health')
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

/**
 * /context is host-agnostic by design (context-document.ts): every context URL
 * in the wild must resolve to the same bytes on whatever origin answers. A
 * JSON-LD document loader is not obliged to follow redirects, so the canonical
 * redirect must not touch it.
 */
test('the JSON-LD context is served on any host, never redirected', async () => {
  const fetchFn = buildFetch({
    apiRoutes: configuredRoutes,
    hostStore: noopHostStore,
    distDir,
    trustedProxyHops: 0,
    canonicalHost: 'originals.build',
  });
  const res = await fetchFn(new Request('https://pichu.originals.build/context'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/ld+json');
});

/**
 * A mixed-case canonical host must not loop. `URL` lowercases the host it
 * parses, so comparing it against a mixed-case configured value would never
 * match and every document request would redirect forever. config.ts rejects
 * such a value at boot; buildFetch normalises so the loop is unreachable
 * whatever the wiring.
 */
test('a mixed-case canonical host serves rather than redirecting forever', async () => {
  const fetchFn = buildFetch({
    apiRoutes: configuredRoutes,
    hostStore: noopHostStore,
    distDir,
    trustedProxyHops: 0,
    canonicalHost: 'Originals.Build',
  });
  const res = await fetchFn(new Request('https://originals.build/app.js'));
  expect(res.status).toBe(200);
});

test('a mixed-case canonical host still redirects a foreign host, to the lowercase form', async () => {
  const fetchFn = buildFetch({
    apiRoutes: configuredRoutes,
    hostStore: noopHostStore,
    distDir,
    trustedProxyHops: 0,
    canonicalHost: 'Originals.Build',
  });
  const res = await fetchFn(new Request('https://x.up.railway.app/page'));
  expect(res.status).toBe(301);
  expect(res.headers.get('location')).toBe('https://originals.build/page');
});

/**
 * #976 B, gap G1; P3.6. A did:webvh names the host it was published on, and
 * the durable store serves by that host. A hosted-layout read on a
 * non-canonical host this instance serves (the legacy did:webvh domain) that
 * holds the object is served there, never bounced to a host that doesn't hold
 * it. Anything else on that host, and every read on a host this instance
 * doesn't serve, still redirects.
 */
describe('hosted-layout reads on the host they were published under', () => {
  const stored = '/user-abc0123456789ab/did.jsonl';
  // The store answers for any host it holds; only the served did:webvh hosts may bypass the redirect.
  const publications = {
    serve: (url: URL) =>
      (url.host === 'magby.originals.build' || url.host === 'intruder.example.com') && url.pathname === stored ? new Response('log') : null,
  };
  const fetchFn = () =>
    buildFetch({ apiRoutes: configuredRoutes, hostStore: noopHostStore, distDir, trustedProxyHops: 0, canonicalHost: 'originals.build', publications });

  test('a stored object is served, not redirected', async () => {
    const res = await fetchFn()(new Request(`https://magby.originals.build${stored}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('log');
  });

  test('a hosted-layout path with nothing stored still redirects', async () => {
    const res = await fetchFn()(new Request('https://magby.originals.build/user-zzz/did.jsonl'));
    expect(res.status).toBe(301);
  });

  test('a document on that host still redirects', async () => {
    const res = await fetchFn()(new Request('https://magby.originals.build/some/page'));
    expect(res.status).toBe(301);
  });

  // P3.6: a did:webvh is fetched from the domain it names, and this instance
  // serves only its own did:webvh hosts. A stored object under any other
  // Host header is not served from here.
  test('a stored object under a host that is not served still redirects', async () => {
    const res = await fetchFn()(new Request(`https://intruder.example.com${stored}`));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`https://originals.build${stored}`);
  });
});

/**
 * #976 B, gap G6. The acceptance receipt compares the deployed revision with
 * the source SHA, so the server reports its own and the SPA's, with or without
 * sign-in configured.
 */
describe('GET /api/version', () => {
  test('reports the server revision and the SPA revision baked into index.html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'landing-dist-rev-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><head><meta name="originals-revision" content="abc1234"></head>');
    try {
      for (const apiRoutes of [configuredRoutes, null]) {
        const fetchFn = buildFetch({ apiRoutes, hostStore: noopHostStore, distDir: dir + '/', trustedProxyHops: 0, revision: 'def456' });
        const res = await fetchFn(new Request('https://originals.build/api/version'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ revision: 'def456', spaRevision: 'abc1234' });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dirty build revision is reported as such, never as the clean SHA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'landing-dist-rev-'));
    writeFileSync(join(dir, 'index.html'), `<head><meta name="originals-revision" content="${'a'.repeat(40)}-dirty"></head>`);
    try {
      const res = await buildFetch({ apiRoutes: null, hostStore: noopHostStore, distDir: dir + '/', trustedProxyHops: 0 })(new Request('https://originals.build/api/version'));
      expect((await res.json()).spaRevision).toBe(`${'a'.repeat(40)}-dirty`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unknown SPA revision is not cached: a later build is read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'landing-dist-rev-'));
    try {
      const fetchFn = buildFetch({ apiRoutes: null, hostStore: noopHostStore, distDir: dir + '/', trustedProxyHops: 0 });
      expect((await (await fetchFn(new Request('https://originals.build/api/version'))).json()).spaRevision).toBeNull();
      writeFileSync(join(dir, 'index.html'), '<head><meta name="originals-revision" content="abc1234"></head>');
      expect((await (await fetchFn(new Request('https://originals.build/api/version'))).json()).spaRevision).toBe('abc1234');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unknown revision is null, never a guess', async () => {
    const fetchFn = buildFetch({ apiRoutes: null, hostStore: noopHostStore, distDir, trustedProxyHops: 0 });
    const res = await fetchFn(new Request('https://originals.build/api/version'));
    expect(await res.json()).toEqual({ revision: null, spaRevision: null });
  });
});
