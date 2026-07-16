import { file } from 'bun';
import { normalize } from 'node:path';
import { route, type Handler } from './router';

// Minimal surface buildFetch depends on; the real store (webvh-host.ts)
// implements exactly these two methods. `handlePut` takes the resolved,
// trustworthy client IP (Bun socket peer) for rate-limit keying — never a
// client-supplied header, which is spoofable.
export interface WebvhHostStore {
  handlePut(req: Request, url: URL, clientIp: string): Promise<Response>;
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
  routes: Record<string, Handler>;
  hostStore: WebvhHostStore;
  distDir: string;
}): (req: Request, server?: BunServerLike) => Promise<Response> {
  const { routes, hostStore, distDir } = deps;
  // Bun calls this with (request, server); server exposes the real peer IP.
  return async (req, server?: BunServerLike) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // 1. WebVH host writes (wildcard path — not expressible in the exact route map).
    if (path.startsWith('/api/host/')) {
      return hostStore.handlePut(req, url, resolveClientIp(req, server));
    }

    // 2. All other /api/* — exact-match route map (auth routes or 503 stubs + health).
    if (path.startsWith('/api/')) return route(req, routes);

    // 3. WebVH log/resource GETs served at the resolver's exact URLs.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const served = hostStore.serve(req, url);
      if (served) return served;
    }

    // 4. Static SPA + fallback (with traversal guard).
    return serveStatic(url, distDir);
  };
}
