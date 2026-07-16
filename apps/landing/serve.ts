/**
 * Unified production server for the landing app (Railway entry).
 *
 * One origin serves: the built SPA (with SPA fallback + traversal guard), the
 * auth API (only when JWT_SECRET + TURNKEY_* are present; otherwise 503 stubs),
 * the WebVH host write endpoint (PUT /api/host/*), and the hosted did:webvh logs
 * at the exact URLs didwebvh-ts's resolver GETs. No secrets are required to run
 * the SPA and the real did:webvh hosting demo (Track A).
 */
import { createInMemorySessionStorage } from '@originals/auth/server';
import { buildFetch } from './server/app';
import { createWebvhHostStore } from './server/webvh-host';
import { buildRoutes, buildStubRoutes } from './server/index';
import { getTurnkey } from './server/turnkey';

const distDir = new URL('./dist/', import.meta.url).pathname;
const hostStore = createWebvhHostStore();

const jwtSecret = process.env.JWT_SECRET;
const turnkeyConfigured =
  !!process.env.TURNKEY_API_PUBLIC_KEY &&
  !!process.env.TURNKEY_API_PRIVATE_KEY &&
  !!process.env.TURNKEY_ORGANIZATION_ID;

let routes;
if (jwtSecret && turnkeyConfigured) {
  routes = buildRoutes({
    turnkey: getTurnkey(),
    sessions: createInMemorySessionStorage(),
    jwtSecret,
  });
  console.log('[landing] auth configured — /api/auth/* live');
} else {
  console.warn(
    '[landing] auth unconfigured (JWT_SECRET/TURNKEY_* absent) — /api/auth/* returns 503; SPA + did:webvh hosting still work'
  );
  routes = buildStubRoutes();
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  hostname: '0.0.0.0',
  fetch: buildFetch({ routes, hostStore, distDir }),
});

console.log(`[landing] unified server on http://0.0.0.0:${server.port}`);
