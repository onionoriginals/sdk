import { file } from 'bun';
import { normalize } from 'node:path';
import { route, type Handler } from './router';

// Minimal surface buildFetch depends on; the real store (webvh-host.ts, Task 4)
// implements exactly these two methods.
export interface WebvhHostStore {
  handlePut(req: Request, url: URL): Promise<Response>;
  serve(req: Request, url: URL): Response | null;
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
}): (req: Request) => Promise<Response> {
  const { routes, hostStore, distDir } = deps;
  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // 1. WebVH host writes (wildcard path — not expressible in the exact route map).
    if (path.startsWith('/api/host/')) return hostStore.handlePut(req, url);

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
