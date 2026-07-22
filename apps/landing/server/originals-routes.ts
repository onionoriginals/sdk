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

// Reject a declared body larger than this before buffering it — the store's
// per-user 25 MiB quota is the real ceiling; no single did:webvh artifact
// (log/cel/resource) comes close, so this is generous headroom, not a limit
// users hit.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * A host key must name a did:webvh hosting artifact: `<segs…>/did.jsonl`,
 * `<segs…>/cel.json`, or `<segs…>/resources/<multibase>`. This confines every
 * authed PUT to the shapes the SDK actually publishes and — crucially — makes
 * it impossible to plant bytes at a path that would SHADOW the app's own static
 * assets (`index.html`, `assets/app-*.js`). `buildFetch` runs `originals.serve`
 * before the SPA/static fallback, so an unconfined key like
 * `<host>/assets/app-abc.js` would otherwise be served (as a forced download,
 * via untrustedHeaders) to every visitor, breaking the page. Cross-user
 * OVERWRITE of a claimed key is separately blocked by the store's owner sidecar.
 */
function isWebvhArtifactKey(key: string): boolean {
  const segs = key.split('/');
  const last = segs[segs.length - 1];
  if (last === 'did.jsonl' || last === 'cel.json') return true;
  // Published resource: `…/resources/<base64url-multibase>` (multibase 'u' prefix).
  return segs[segs.length - 2] === 'resources' && /^u[A-Za-z0-9_-]+$/.test(last);
}

/** The caller's per-user namespace slug — mirrors userWebvhSlug in src/auth/webvh.ts. */
function userSlug(sub: string): string {
  return `user-${sub.slice(0, 16)}`;
}

/**
 * Decode the host object key from the request path, or null when it contains a
 * malformed percent-encoding (`%GG`). Bun's URL accepts such paths, so a bare
 * decodeURIComponent would throw URIError → an uncaught 500; callers turn null
 * into a clean 400.
 */
function decodeKey(url: URL): string | null {
  try {
    return decodeURIComponent(url.pathname.slice(HOST_PREFIX.length));
  } catch {
    return null;
  }
}

export interface OriginalsRoutes {
  hostPut(req: Request, url: URL, clientIp: string): Promise<Response>;
  hostGet(req: Request, url: URL): Promise<Response>;
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
    if (msg === 'FORBIDDEN') return json({ error: 'forbidden' }, 403);
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

    const key = decodeKey(url);
    if (key === null) return json({ error: 'bad_key' }, 400);
    if (!key) return json({ error: 'missing_key' }, 400);
    // Confine writes to did:webvh artifact paths so a user can't shadow the
    // app's own static assets (served by originals.serve before the fallback).
    if (!isWebvhArtifactKey(key)) return json({ error: 'forbidden_path' }, 403);
    // Namespace guard: a `user-<slug>` path segment is a per-user namespace —
    // only its owner may write there. Blocks pre-squatting another user's
    // PREDICTABLE publisher DID path (`user-<victim>/did.jsonl`), which the
    // store's first-writer-wins owner sidecar alone can't (it only protects an
    // already-claimed key). Asset paths are hash-derived (not `user-`-prefixed),
    // so they stay open and are overwrite-protected by the sidecar.
    const nsSeg = key.split('/')[1]; // [0] is the host
    if (nsSeg && nsSeg.startsWith('user-') && nsSeg !== userSlug(sub)) {
      return json({ error: 'forbidden_namespace' }, 403);
    }
    // Cap the upload before buffering the whole body into memory (the rate
    // limiter bounds request COUNT, not per-request size).
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      return json({ error: 'payload_too_large' }, 413);
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return json({ error: 'payload_too_large' }, 413);
    const contentType = req.headers.get('content-type') ?? 'application/octet-stream';
    try {
      store.saveBytes(sub, key, bytes, contentType);
    } catch (e) {
      return storeError(e);
    }
    return json({ ok: true }, 200);
  }

  // adapter.get: read back an object under this user's account (auth-scoped in
  // the store). GET on the same wildcard path hostPut writes to.
  async function hostGet(req: Request, url: URL): Promise<Response> {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const key = decodeKey(url);
    if (key === null) return json({ error: 'bad_key' }, 400);
    if (!key) return json({ error: 'missing_key' }, 400);
    try {
      return store.read(sub, key);
    } catch (e) {
      return storeError(e);
    }
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

  return { hostPut, hostGet, record, list, serve: (url) => store.serve(url) };
}
