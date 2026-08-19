import { file } from 'bun';
import { normalize } from 'node:path';
import { route, json, type Handler } from './router';
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
function documentHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': DOCUMENT_CSP,
    'x-content-type-options': 'nosniff',
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
  log?: (message: string) => void;
}): (req: Request, server?: BunServerLike) => Promise<Response> {
  const { apiRoutes, hostStore, distDir, originals } = deps;
  const hops = deps.trustedProxyHops ?? trustedProxyHops();
  const log = deps.log ?? ((m: string) => console.log(m));
  // One sample per process so the hop count can be checked against the live
  // proxy (see client-ip.ts) without a debug endpoint or per-request logging.
  let sampled = false;

  // Bun calls this with (request, server); server exposes the real peer IP.
  return async (req, server?: BunServerLike) => {
    const url = new URL(req.url);
    const path = url.pathname;

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

    // 3. WebVH log/resource GETs served at the resolver's exact URLs.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const served = hostStore.serve(req, url);
      if (served) return served;
      const durable = originals?.serve(url);
      if (durable) return durable;
    }

    // 4. Static SPA + fallback (with traversal guard).
    return serveStatic(url, distDir);
  };
}
