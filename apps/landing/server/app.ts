import { file } from 'bun';
import { normalize } from 'node:path';
import { route, json, type Handler } from './router';
import type { OriginalsRoutes } from './originals-routes';

// Minimal surface buildFetch depends on; the real store (webvh-host.ts)
// implements exactly these two methods. `handlePut` takes the resolved,
// trustworthy client IP (Bun socket peer) for rate-limit keying — never a
// client-supplied header, which is spoofable.
export interface WebvhHostStore {
  handlePut(req: Request, url: URL, clientIp: string): Promise<Response>;
  read(url: URL): Response;
  serve(req: Request, url: URL): Response | null;
}

// Just the slice of Bun's Server we use: the real peer IP of the connection.
interface BunServerLike {
  requestIP?(req: Request): { address: string } | null;
}

// The rate-limit key: the actual socket peer IP, which a client cannot spoof.
// (Behind a proxy this is the proxy's IP — coarse but fail-safe: a spoofed
// X-Forwarded-For can no longer mint unlimited buckets.)
function resolveClientIp(req: Request, server?: BunServerLike): string {
  return server?.requestIP?.(req)?.address || 'local';
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
  if (await f.exists()) return new Response(f);
  // SPA fallback: client-side routes have no file on disk.
  return new Response(file(distDir + 'index.html'), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
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
}): (req: Request, server?: BunServerLike) => Promise<Response> {
  const { apiRoutes, hostStore, distDir, originals } = deps;
  // Bun calls this with (request, server); server exposes the real peer IP.
  return async (req, server?: BunServerLike) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // 1. WebVH host store (wildcard path — not expressible in the exact route
    // map). GET/HEAD read an object by key (adapter.get); PUT writes. Always
    // available (no auth required — Track A runs without secrets).
    if (path.startsWith('/api/host/')) {
      if (req.method === 'GET' || req.method === 'HEAD') return hostStore.read(url);
      return hostStore.handlePut(req, url, resolveClientIp(req, server));
    }

    // 1b. Durable per-user Originals hosting (auth-gated). Same wildcard shape,
    // but persisted and namespaced by the JWT sub.
    if (originals && path.startsWith('/api/originals/host/')) {
      if (req.method === 'GET' || req.method === 'HEAD') return originals.hostGet(req, url);
      return originals.hostPut(req, url, resolveClientIp(req, server));
    }

    // 2. All other /api/* — dispatch when configured, else a clear JSON 404
    // (matches main's behavior; never SPA-fallback /api/* to index.html).
    if (path === '/api' || path.startsWith('/api/')) {
      if (apiRoutes) return route(req, apiRoutes);
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
