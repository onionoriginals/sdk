/**
 * Production server for the landing app (Railway) — single service.
 *
 * Serves the built SPA (`apps/landing/dist`) on `$PORT`, and — when the Turnkey
 * auth env is present — ALSO mounts the `/api` auth routes in the SAME process,
 * so Sign-in / session work same-origin (no CORS, httpOnly cookie). Without that
 * env it serves the static site only and `/api/*` returns a clear JSON 404.
 *
 * Enable the auth API by setting on the Railway service:
 *   TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID, JWT_SECRET
 * Sessions are in-memory (fine for a single instance; use a shared store if you
 * scale to multiple).
 */
import { file } from 'bun';
import { normalize } from 'node:path';
import { createInMemorySessionStorage } from '@originals/auth/server';
import { route, json, type Handler } from './server/router';
import { buildRoutes } from './server/index';
import { getTurnkey } from './server/turnkey';

const DIST = new URL('./dist/', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 3000);

function buildApiRoutes(): Record<string, Handler> | null {
  const jwtSecret = process.env.JWT_SECRET;
  const configured =
    jwtSecret &&
    process.env.TURNKEY_API_PUBLIC_KEY &&
    process.env.TURNKEY_API_PRIVATE_KEY &&
    process.env.TURNKEY_ORGANIZATION_ID;
  if (!configured) return null;
  return buildRoutes({ turnkey: getTurnkey(), sessions: createInMemorySessionStorage(), jwtSecret });
}

const apiRoutes = buildApiRoutes();

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
    // Auth API: dispatch when configured, else a clear JSON 404 (never
    // SPA-fallback /api/* to index.html — the client would parse HTML as JSON).
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (apiRoutes) return route(req, apiRoutes);
      return json(
        { error: 'Auth API not configured — set TURNKEY_* + JWT_SECRET on this service to enable Sign-in.' },
        404
      );
    }
    // Strip leading slashes, normalize, and reject path traversal.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\/+/, '');
    if (rel.includes('..')) return new Response('Bad request', { status: 400 });
    return serveFile(rel === '' ? 'index.html' : rel);
  },
});

console.log(
  `[landing] serving ${DIST} on http://0.0.0.0:${server.port} (auth API: ${apiRoutes ? 'enabled' : 'static-only'})`
);
