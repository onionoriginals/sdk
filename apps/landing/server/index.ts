import { createInMemorySessionStorage, type SessionStorage } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { json, type Handler } from './router';
import { getTurnkey } from './turnkey';
import { createAuthRoutes } from './auth-routes';
import { buildFetch } from './app';
import { createWebvhHostStore } from './webvh-host';
import type { BitcoinRoutes } from './bitcoin';
import { createOriginalsStore } from './originals-store';
import { createOriginalsRoutes, type OriginalsRoutes } from './originals-routes';

// did:webvh creation is client-side (browser Ed25519 key, see src/auth/webvh.ts):
// the parent Turnkey key can't sign for a credential-less sub-org, so there is
// no server DID route. Optional `bitcoin` mounts the Track B /api/btc/* routes
// (testnet4 inscription) when the deploy provides a QuickNode endpoint + faucet.
export function buildRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
  bitcoin?: BitcoinRoutes;
  originals?: OriginalsRoutes;
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
  if (deps.originals) {
    routes['POST /api/originals'] = deps.originals.record;
    routes['GET /api/originals'] = deps.originals.list;
  }
  return routes;
}

// Standalone dev API server (Vite proxies /api → here). Routes through the same
// buildFetch as prod so /api/host/* (webvh hosting) works in dev too.
if (import.meta.main) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET environment variable is required');
  const originalsStore = createOriginalsStore({
    dataDir: process.env.ORIGINALS_DATA_DIR ?? './.originals-data',
  });
  const originals = createOriginalsRoutes({ jwtSecret, store: originalsStore });
  const apiRoutes = buildRoutes({
    turnkey: getTurnkey(),
    sessions: createInMemorySessionStorage(),
    jwtSecret,
    originals,
  });
  const hostStore = createWebvhHostStore();
  const distDir = new URL('../dist/', import.meta.url).pathname;
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 8787),
    fetch: buildFetch({ apiRoutes, hostStore, distDir, originals }),
  });
  console.log(`[auth-server] listening on http://localhost:${server.port}`);
}
