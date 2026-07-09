import { createInMemorySessionStorage, type SessionStorage } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { json, route, type Handler } from './router';
import { getTurnkey } from './turnkey';
import { createAuthRoutes } from './auth-routes';
import { createDidRoutes } from './did-routes'; // added in Phase 2; safe no-op table until then

export function buildRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
}): Record<string, Handler> {
  const auth = createAuthRoutes(deps);
  const did = createDidRoutes(deps);
  return {
    'GET /api/health': () => json({ status: 'ok' }),
    'POST /api/auth/send-otp': auth.sendOtp,
    'POST /api/auth/verify-otp': auth.verifyOtp,
    'GET /api/me': auth.me,
    'POST /api/auth/logout': auth.logout,
    'POST /api/did/create': did.createDid,
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
