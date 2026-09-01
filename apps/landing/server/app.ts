import { file } from 'bun';
import { normalize } from 'node:path';
import { route, json, type Handler } from './router';
import { serveContextDocument, CONTEXT_PATH } from './context-document';
import type { OriginalsRoutes } from './originals-routes';
import {
  resolveClientIp,
  trustedProxyHops,
  formatProxySample,
  type SocketPeerSource,
} from './client-ip';

// Minimal surface buildFetch depends on; the real store (webvh-host.ts)
// implements exactly these two methods. `handlePut` takes the resolved client
// identity (client-ip.ts) for rate-limit keying — never a raw client-supplied
// header, which is spoofable.
export interface WebvhHostStore {
  handlePut(req: Request, url: URL, clientIp: string): Promise<Response>;
  read(url: URL): Response;
  serve(req: Request, url: URL): Response | null;
}

type BunServerLike = SocketPeerSource;

// The application document is the one response that will hold a live signing
// credential (and, on the browser-readable fallback, a plaintext authorship
// seed), so it pins every executable origin to this one. The app already
// commits to zero external runtime dependencies — self-hosted fonts, no CDNs,
// no trackers — so 'self' IS the allowlist; the single third-party exception is
// Turnkey's API, which the browser SDK calls directly. Deliberately unlike
// untrustedHeaders() in webvh-host.ts: that policy (`default-src 'none';
// sandbox`) is for bytes a stranger uploaded, and would blank this page.
const DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // No 'unsafe-inline': the bundle ships no inline <style> and React applies
  // style props through CSSOM, which CSP does not gate. Adding one would
  // silently need this back — dev (vite) serves without a policy, so check a
  // built page through this server, not `bun run dev`.
  "style-src 'self'",
  // data: for the two things the bundle genuinely inlines — the runtime-
  // generated artwork <img> and vite's inlined woff faces. Never for script.
  "img-src 'self' data:",
  "font-src 'self' data:",
  // Turnkey's API is the ONLY cross-origin destination: the browser SDK signs
  // against it directly. did:webvh resolution is same-origin (the log lives on
  // this host), and 'self' covers its https:// form on an http origin.
  "connect-src 'self' https://api.turnkey.com",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

// nosniff alongside it: the policy is only worth what the content-type is, and
// a sniffed response can execute under the wrong type.
//
// HSTS is the backstop under the auth cookie (SEC-1): the 7-day JWT gates every
// money route, and one plaintext request — a typed http:// URL, a stale
// bookmark — is all an interception needs. A browser that has seen this header
// will not make that request at all. One year with subdomains; not `preload`,
// which is a submission an operator makes deliberately, not a header default.
// Ignored by browsers over plain http, so local dev is unaffected.
function documentHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': DOCUMENT_CSP,
    'x-content-type-options': 'nosniff',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
  };
}

async function serveStatic(url: URL, distDir: string): Promise<Response> {
  // Reject traversal on the DECODED path before normalize collapses `..`
  // segments (e.g. `%2f..%2f` → `/../` would otherwise normalize past root and
  // slip through). Any `..` segment in the requested path is rejected outright.
  const decoded = decodeURIComponent(url.pathname);
  if (decoded.split(/[/\\]/).includes('..')) {
    return new Response('Bad request', { status: 400 });
  }
  const rel = normalize(decoded)
    .replace(/^(\.\.(\/|\\|$))+/, '')
    .replace(/^\/+/, '');
  if (rel.includes('..')) return new Response('Bad request', { status: 400 });
  const target = rel === '' ? 'index.html' : rel;
  const f = file(distDir + target);
  // Both branches can return the document (`/` and `/index.html` hit the first,
  // every client-side route the second), so both must carry its headers. Other
  // static assets keep the plain file response.
  if (await f.exists()) {
    return target === 'index.html' ? new Response(f, { headers: documentHeaders() }) : new Response(f);
  }
  // SPA fallback: client-side routes have no file on disk.
  return new Response(file(distDir + 'index.html'), { headers: documentHeaders() });
}

export function buildFetch(deps: {
  // The exact-match API route map (auth + optional /api/btc/*), or null when the
  // Turnkey/JWT env is absent — then /api/* returns a clean JSON 404 (never
  // SPA-fallback /api/* to index.html). The WebVH host store below is always on:
  // Track A (did:webvh hosting) must run without any secrets.
  apiRoutes: Record<string, Handler> | null;
  hostStore: WebvhHostStore;
  distDir: string;
  // Durable per-user Originals (auth-gated). Present only when auth is configured.
  originals?: OriginalsRoutes | null;
  // How many proxies sit in front of this process. Snapshotted at construction
  // from TRUSTED_PROXY_HOPS; tests pass it explicitly.
  trustedProxyHops?: number;
  // The one hostname did:webvh identifiers may be pinned to (#529). Document
  // requests on any other host are redirected here. Undefined in dev and tests,
  // where no redirect happens at all.
  canonicalHost?: string;
  log?: (message: string) => void;
}): (req: Request, server?: BunServerLike) => Promise<Response> {
  const { apiRoutes, hostStore, distDir, originals } = deps;
  // Lowercased once, not per request: `URL` lowercases the host it parses, so
  // comparing against a mixed-case value would never match and every document
  // request would redirect forever. config.ts rejects a non-lowercase value at
  // boot; this makes the loop unreachable for any caller, however wired.
  const canonicalHost = deps.canonicalHost?.toLowerCase();
  const hops = deps.trustedProxyHops ?? trustedProxyHops();
  const log = deps.log ?? ((m: string) => console.log(m));
  // One sample per process so the hop count can be checked against the live
  // proxy (see client-ip.ts) without a debug endpoint or per-request logging.
  let sampled = false;

  // Bun calls this with (request, server); server exposes the real peer IP.
  return async (req, server?: BunServerLike) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // 0. Canonical host (#529). A visitor on the Railway-generated hostname
    // would mint did:webvh identifiers pinned to it, permanently — `demoHost()`
    // reads window.location.host. Bounce documents to the one host DIDs may
    // name, before anything can serve them the SPA.
    //
    // /api/* is deliberately exempt: a 301 on a PUT is not safely replayable,
    // publishing writes to whichever origin the page is on (the KEY carries the
    // canonical domain, so the object still serves correctly), and a platform
    // probe must not have to chase a redirect to find a healthy process.
    //
    // /context is exempt for a different reason: it is host-agnostic BY DESIGN
    // (see context-document.ts) so that every context URL in the wild resolves
    // to the same bytes on whatever origin answers. A JSON-LD document loader
    // is not obliged to follow redirects, so bouncing it could break credential
    // verification for an external verifier — the one thing that route exists
    // to keep working.
    if (
      canonicalHost &&
      url.host !== canonicalHost &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      path !== CONTEXT_PATH &&
      path !== '/api' &&
      !path.startsWith('/api/')
    ) {
      const to = new URL(url.toString());
      to.protocol = 'https:';
      to.host = canonicalHost;
      return new Response(null, { status: 301, headers: { location: to.toString() } });
    }

    // ONE client identity per request, shared by every rate-limited route.
    const clientIp = resolveClientIp(req, server, { hops });
    if (!sampled && (hops > 0 || req.headers.get('x-forwarded-for') !== null)) {
      sampled = true;
      log(formatProxySample(req, clientIp, hops));
    }

    // 1. WebVH host store (wildcard path — not expressible in the exact route
    // map). GET/HEAD read an object by key (adapter.get); PUT writes. Always
    // available (no auth required — Track A runs without secrets).
    if (path.startsWith('/api/host/')) {
      if (req.method === 'GET' || req.method === 'HEAD') return hostStore.read(url);
      return hostStore.handlePut(req, url, clientIp);
    }

    // 1b. Durable per-user Originals hosting (auth-gated). Same wildcard shape,
    // but persisted and namespaced by the JWT sub.
    if (originals && path.startsWith('/api/originals/host/')) {
      if (req.method === 'GET' || req.method === 'HEAD') return originals.hostGet(req, url);
      return originals.hostPut(req, url, clientIp);
    }

    // 2. All other /api/* — dispatch when configured, else a clear JSON 404
    // (matches main's behavior; never SPA-fallback /api/* to index.html).
    if (path === '/api' || path.startsWith('/api/')) {
      if (apiRoutes) return route(req, apiRoutes, clientIp);
      return json(
        { error: 'Auth API not configured — set TURNKEY_* + JWT_SECRET on this service to enable Sign-in.' },
        404
      );
    }

    // 3. The JSON-LD context every issued credential points at.
    //
    // Ahead of the host stores, not after them, and that ORDER IS THE SECURITY
    // PROPERTY. `/api/host/*` is unauthenticated with client-chosen keys, and
    // hostStore.serve() looks a request up as `${url.host}${url.pathname}` —
    // so a stranger who PUTs `originals.build/context` would otherwise shadow
    // this route and hand every external verifier bytes of their choosing.
    //
    // That store's usual defence does not apply here. Anonymous writes are
    // acceptable for did:webvh logs because those are self-certifying: tamper
    // with one and it fails verification. A JSON-LD context certifies nothing.
    // It DEFINES the terms every credential is read through, so replacing it
    // silently changes what those credentials mean — or, served as garbage,
    // breaks every verification at once. It must not be shadowable, so it is
    // resolved first and the write path refuses the key (see webvh-host.ts).
    const context = serveContextDocument(req, url);
    if (context) return context;

    // 4. WebVH log/resource GETs served at the resolver's exact URLs.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const served = hostStore.serve(req, url);
      if (served) return served;
      const durable = originals?.serve(url);
      if (durable) return durable;
    }

    // 5. Static SPA + fallback (with traversal guard).
    return serveStatic(url, distDir);
  };
}
