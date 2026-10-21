/**
 * Auth-gated routes for durable per-user Originals.
 *
 *   PUT /api/originals/host/<encoded key>   store a hosted file (hosted-layout.ts)
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
import type { OriginalsStore, OriginalInscription } from './originals-store';
import { bytesMatchDigest, classifyHostedKey, hostedContentType, parseWitnessFile, signedMediaType, signerLogVerdict, signerWitnessVerdict } from './hosted-layout';
import { readBodyCapped } from './body';

const HOST_PREFIX = '/api/originals/host/';

// Reject a declared body larger than this before buffering it — the store's
// per-user 25 MiB quota is the real ceiling; no single did:webvh artifact
// (log, evidence file or resource) comes close, so this is generous headroom, not a limit
// users hit.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** The caller's per-user namespace slug — mirrors userWebvhSlug in src/auth/webvh.ts. */
function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

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
  // 120 writes/min per resolved client identity (client-ip.ts) — never a raw
  // X-Forwarded-For. A publish issues a handful of writes, so this is ~20
  // publishes/min for one signed-in creator; the auth gate and the per-user
  // namespace are the real bounds.
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
    if (msg === 'INCONSISTENT_OWNERSHIP') return json({ error: 'inconsistent_ownership' }, 409);
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
    // Only the hosted layout, inside the caller's own namespace (hosted-layout.ts):
    // no write can shadow the app's static assets or another author's files.
    const hosted = classifyHostedKey(key, userSlug(sub));
    if (!hosted) return json({ error: 'forbidden_path' }, 403);
    // Cap the upload in bytes while reading it, declared or chunked (the rate
    // limiter bounds request COUNT, not per-request size).
    const bytes = await readBodyCapped(req, MAX_UPLOAD_BYTES);
    if (!bytes) return json({ error: 'payload_too_large' }, 413);
    // The server labels every file itself. A resource takes the media type of
    // its descriptor in the Original's asset log, uploaded first, and
    // must be the bytes its digest names (P9.7).
    let contentType: string;
    if (hosted.kind === 'resource') {
      if (!bytesMatchDigest(bytes, hosted.digest)) return json({ error: 'digest_mismatch' }, 422);
      const log = store.read(sub, hosted.assetLogKey);
      const mediaType = log.ok ? signedMediaType(await log.text(), hosted.digest) : null;
      if (!mediaType) return json({ error: 'resource_not_in_log' }, 409);
      contentType = mediaType;
    } else {
      contentType = hostedContentType(hosted);
    }
    // A signer's DID log and witness only grow, so an upload can never roll
    // back a newer one, and the revocation in it (P7.8; #965 review C2). A log
    // is judged by verification against the stored log's verified prefix
    // (#965 review r2 #6). The verdict is reached asynchronously; the stored
    // bytes are then re-read, and the write happens in the same synchronous
    // step only if they are what was judged, so no other upload interleaves.
    let write = bytes;
    if (hosted.kind === 'evidence' && hosted.signer === 'log') {
      const witnessKey = key.replace(/did\.jsonl$/, 'did-witness.json');
      for (let attempt = 0; ; attempt++) {
        const stored = store.readHosted(key);
        const witnessBytes = store.readHosted(witnessKey);
        const verdict = await signerLogVerdict(stored, bytes, hosted.signerHex!, parseWitnessFile(witnessBytes));
        if (verdict) return json({ error: verdict }, verdict === 'identity_log_invalid' ? 422 : 409);
        if (sameBytes(store.readHosted(key), stored) && sameBytes(store.readHosted(witnessKey), witnessBytes)) break;
        if (attempt >= 2) return json({ error: 'identity_log_contended' }, 409);
      }
    } else if (hosted.kind === 'evidence' && hosted.signer === 'witness') {
      // Judged by the proofs it carries and by the stored log it must never
      // weaken (#965 review r4, finding 3), with the same re-read as a log.
      const logKey = key.replace(/did-witness\.json$/, 'did.jsonl');
      for (let attempt = 0; ; attempt++) {
        const stored = store.readHosted(key);
        const log = store.readHosted(logKey);
        const verdict = await signerWitnessVerdict(stored, bytes, log, hosted.signerHex!, { maxBytes: MAX_UPLOAD_BYTES });
        if ('error' in verdict) return json({ error: verdict.error }, verdict.error === 'identity_witness_too_large' ? 413 : 409);
        write = verdict.write;
        if (sameBytes(store.readHosted(key), stored) && sameBytes(store.readHosted(logKey), log)) break;
        if (attempt >= 2) return json({ error: 'identity_witness_contended' }, 409);
      }
    }
    try {
      store.saveBytes(sub, key, write, contentType);
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
    const body = (await req.json().catch(() => ({}))) as {
      did?: string;
      title?: string;
      resourceHash?: string;
      btcoDid?: unknown;
      inscriptionId?: unknown;
      commitTxId?: unknown;
      revealTxId?: unknown;
      satoshi?: unknown;
      status?: unknown;
    };
    const { did, title, resourceHash } = body;
    if (typeof did !== 'string' || typeof title !== 'string' || typeof resourceHash !== 'string') {
      return json({ error: 'bad_request' }, 400);
    }
    // Optional inscription fields (posted after the did:btco migrate). Each is
    // taken only when it is a well-formed string — a malformed value 400s
    // rather than silently landing in the durable record.
    const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
    const inscription: OriginalInscription = {};
    for (const k of ['btcoDid', 'inscriptionId', 'commitTxId', 'revealTxId', 'satoshi'] as const) {
      const v = body[k];
      if (v === undefined) continue;
      if (!str(v)) return json({ error: 'bad_request' }, 400);
      inscription[k] = v;
    }
    if (body.status !== undefined) {
      if (body.status !== 'pending' && body.status !== 'confirmed') return json({ error: 'bad_request' }, 400);
      inscription.inscriptionStatus = body.status;
    }
    try {
      store.recordOriginal(sub, {
        did,
        title,
        resourceHash,
        createdAt: new Date(now()).toISOString(),
        ...inscription,
      });
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
