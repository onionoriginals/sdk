/**
 * Production static server for the built landing SPA (Railway).
 *
 * Serves `apps/landing/dist` on $PORT with SPA fallback (unknown non-asset
 * routes → index.html). Static-only: the auth API (`server/index.ts`) is a
 * separate service that needs Turnkey creds — deploy it alongside and point the
 * proxy/`VITE_*` at it if you want the Sign-in / did:webvh features live.
 */
import { file } from 'bun';
import { normalize } from 'node:path';

const DIST = new URL('./dist/', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 3000);

async function serveFile(relPath: string): Promise<Response> {
  const f = file(DIST + relPath);
  if (await f.exists()) return new Response(f);
  // SPA fallback: client-side routes have no file on disk.
  return new Response(file(DIST + 'index.html'), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url);
    // Strip leading slashes, normalize, and reject path traversal.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\/+/, '');
    if (rel.includes('..')) return new Response('Bad request', { status: 400 });
    return serveFile(rel === '' ? 'index.html' : rel);
  },
});

console.log(`[landing] serving ${DIST} on http://0.0.0.0:${server.port}`);
