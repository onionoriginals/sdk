import { createInMemorySessionStorage, type SessionStorage } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { json, route, type Handler } from './router';
import { getTurnkey } from './turnkey';
import { createAuthRoutes } from './auth-routes';
import type { BitcoinRoutes } from './bitcoin';

// did:webvh creation is client-side (browser Ed25519 key, see src/auth/webvh.ts):
// the parent Turnkey key can't sign for a credential-less sub-org, so there is
// no server DID route.
export function buildRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
  bitcoin?: BitcoinRoutes;
}): Record<string, Handler> {
  const auth = createAuthRoutes(deps);
  const routes: Record<string, Handler> = {
    'GET /api/health': () => json({ status: 'ok' }),
    'POST /api/auth/send-otp': auth.sendOtp,
    'POST /api/auth/verify-otp': auth.verifyOtp,
    'GET /api/me': auth.me,
    'POST /api/auth/logout': auth.logout,
  };
  if (deps.bitcoin) {
    routes['POST /api/btc/funding'] = deps.bitcoin.funding;
    routes['POST /api/btc/sat'] = deps.bitcoin.sat;
    routes['POST /api/btc/fee'] = deps.bitcoin.fee;
    routes['POST /api/btc/broadcast'] = deps.bitcoin.broadcast;
  }
  return routes;
}

// Routes for when Turnkey/JWT env is absent: health works, auth returns 503 so
// the SPA + Track A (real webvh hosting) run WITHOUT any secrets.
export function buildStubRoutes(): Record<string, Handler> {
  const unavailable: Handler = () =>
    json(
      { error: 'auth_unconfigured', message: 'Authentication is not configured on this server.' },
      503
    );
  return {
    'GET /api/health': () => json({ status: 'ok' }),
    'POST /api/auth/send-otp': unavailable,
    'POST /api/auth/verify-otp': unavailable,
    'GET /api/me': unavailable,
    'POST /api/auth/logout': unavailable,
  };
}

if (import.meta.main) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET environment variable is required');
  const routes = buildRoutes({
    turnkey: getTurnkey(),
    sessions: createInMemorySessionStorage(),
    jwtSecret,
  });
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 8787),
    fetch: (req) => route(req, routes),
  });
  console.log(`[auth-server] listening on http://localhost:${server.port}`);
}
