/**
 * Auth-gated routes for durable per-user Originals.
 *
 *   PUT /api/originals/host/<encoded key>   store did:webvh log/cel/resource bytes
 *   POST /api/originals                     record an Original summary
 *   GET  /api/originals                     list the user's Originals
 *   serve(url)                              durable read at the resolver URL
 *
 * Every route requires a valid JWT (cookie or Bearer); the store is namespaced
 * by the JWT `sub`, so a user only ever writes/reads under their own account.
 */
import { verifyToken } from '@originals/auth/server';
import { json, type Handler } from './router';
import { extractToken } from './cookies';
import { createRateLimiter } from './rate-limit';
import type { OriginalsStore } from './originals-store';

const HOST_PREFIX = '/api/originals/host/';

export interface OriginalsRoutes {
  hostPut(req: Request, url: URL, clientIp: string): Promise<Response>;
  record: Handler;
  list: Handler;
  serve(url: URL): Response | null;
}

export function createOriginalsRoutes(deps: {
  jwtSecret: string;
  store: OriginalsStore;
  now?: () => number;
}): OriginalsRoutes {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());
  const putLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });

  /** Authenticated subOrgId, or null (→ 401). */
  function authSub(req: Request): string | null {
    const token = extractToken(req);
    if (!token) return null;
    try {
      return verifyToken(token, { secret: deps.jwtSecret }).sub;
    } catch {
      return null;
    }
  }

  function storeError(e: unknown): Response {
    const msg = (e as Error).message;
    if (msg === 'STORE_FULL') return json({ error: 'store_full' }, 507);
    if (msg === 'BAD_KEY') return json({ error: 'bad_key' }, 400);
    return json({ error: 'store_error', message: msg }, 500);
  }

  async function hostPut(req: Request, url: URL, clientIp: string): Promise<Response> {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    if (req.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);

    const rl = putLimiter.check(clientIp);
    if (!rl.allowed) {
      return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) });
    }

    const key = decodeURIComponent(url.pathname.slice(HOST_PREFIX.length));
    if (!key) return json({ error: 'missing_key' }, 400);
    const bytes = new Uint8Array(await req.arrayBuffer());
    const contentType = req.headers.get('content-type') ?? 'application/octet-stream';
    try {
      store.saveBytes(sub, key, bytes, contentType);
    } catch (e) {
      return storeError(e);
    }
    return json({ ok: true }, 200);
  }

  const record: Handler = async (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const { did, title, resourceHash } = (await req.json().catch(() => ({}))) as {
      did?: string;
      title?: string;
      resourceHash?: string;
    };
    if (typeof did !== 'string' || typeof title !== 'string' || typeof resourceHash !== 'string') {
      return json({ error: 'bad_request' }, 400);
    }
    try {
      store.recordOriginal(sub, { did, title, resourceHash, createdAt: new Date(now()).toISOString() });
    } catch (e) {
      return storeError(e);
    }
    return json({ ok: true }, 200);
  };

  const list: Handler = (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    return json({ originals: store.list(sub) });
  };

  return { hostPut, record, list, serve: (url) => store.serve(url) };
}
