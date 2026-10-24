/**
 * Auth-gated routes for durable per-user Originals.
 *
 *   PUT /api/originals/host/<encoded key>   store a hosted file (hosted-layout.ts)
 *   POST /api/originals/submit/<site key>   a shared-host save of one entry (shared-saves.ts, P6.7)
 *   POST /api/originals                     record an Original summary
 *   GET  /api/originals                     list the user's Originals
 *   serve(url)                              durable read at the resolver URL
 *
 * Every route requires a valid JWT (cookie or Bearer); the store is namespaced
 * by the JWT `sub`, so a user only ever writes/reads under their own account.
 * The one exception is a shared-host save into someone's namespace: the
 * entry's validity under the profile authorizes the change (P5.4, P6.7), and
 * the caller must be the namespace owner or an account whose landing DID the
 * head state names as author or editor (P5.15; owner decision of 22 October
 * 2026). Any other caller is refused before its body is read. Accepted files
 * stay the namespace owner's.
 *
 * Once an Original's asset log is hosted, it changes only through the
 * verifying submit route: a PUT of the asset log is taken only when there is
 * none yet (the first publication) or it repeats the stored log byte for byte
 * (a retried publication, P9.2). A PUT of whole lines the stored log starts
 * with is a first publication retried after a save landed: answered as
 * already published, with nothing written (r2 #9). Anything else is refused
 * (409), so an upload can neither roll back nor advance, unverified, a head
 * the host accepted (shared-host PR review C4).
 */
import { verifyToken } from '@originals/auth/server';
import { json, type Handler } from './router';
import { extractToken } from './cookies';
import { createRateLimiter } from './rate-limit';
import type { OriginalsStore, OriginalInscription } from './originals-store';
import { bytesMatchDigest, classifyHostedKey, hostedContentType, parseWitnessFile, signedMediaType, signerLogVerdict, signerWitnessVerdict } from './hosted-layout';
import { readBodyCapped } from './body';
import { createSharedSaves, parseSubmission } from './shared-saves';

import type { AnchoringLibrary } from './originals-library';

const HOST_PREFIX = '/api/originals/host/';
const SUBMIT_PREFIX = '/api/originals/submit/';
// A submission carries one entry, the bytes it introduces (base64) and its signer's DID logs.
const MAX_SUBMIT_BYTES = 12 * 1024 * 1024;

// Reject a declared body larger than this before buffering it — the store's
// per-user 25 MiB quota is the real ceiling; no single did:webvh artifact
// (log, evidence file or resource) comes close, so this is generous headroom, not a limit
// users hit.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** True when `prefix` is a shorter run of whole lines at the start of `log`. */
function isLinePrefix(prefix: Uint8Array, log: Uint8Array): boolean {
  if (prefix.length === 0 || prefix.length >= log.length || prefix[prefix.length - 1] !== 0x0a) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== log[i]) return false;
  return true;
}

/** True when `manifest` names a head that the hosted asset log `log` lists before its last entry. */
function supersededManifest(manifest: Uint8Array, log: Uint8Array | null): boolean {
  if (!log) return false;
  try {
    const head = (JSON.parse(new TextDecoder().decode(manifest)) as { head?: unknown }).head;
    const ids = new TextDecoder().decode(log).trimEnd().split('\n').map((l) => (JSON.parse(l) as { versionId?: unknown }).versionId);
    return typeof head === 'string' && ids.includes(head) && ids[ids.length - 1] !== head;
  } catch {
    return false;
  }
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
function decodeKey(url: URL, prefix = HOST_PREFIX): string | null {
  try {
    return decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

export interface OriginalsRoutes {
  hostPut(req: Request, url: URL, clientIp: string): Promise<Response>;
  hostGet(req: Request, url: URL): Promise<Response>;
  submit(req: Request, url: URL, clientIp: string): Promise<Response>;
  record: Handler;
  list: Handler;
  evidence: Handler;
  serve(url: URL): Response | null;
}

export function createOriginalsRoutes(deps: {
  jwtSecret: string;
  store: OriginalsStore;
  now?: () => number;
  library?: AnchoringLibrary;
}): OriginalsRoutes {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());
  // 120 writes/min per resolved client identity (client-ip.ts) — never a raw
  // X-Forwarded-For. A publish issues a handful of writes, so this is ~20
  // publishes/min for one signed-in creator; the auth gate and the per-user
  // namespace are the real bounds.
  const putLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });
  // Each save is one signed entry, so 60/min per client is far above any editor's pace.
  const submitLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
  const sharedSaves = createSharedSaves({ store, now });

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
        const verdict = await signerLogVerdict(stored, bytes, hosted.signerHex!, parseWitnessFile(witnessBytes), now());
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
        const verdict = await signerWitnessVerdict(stored, bytes, log, hosted.signerHex!, { maxBytes: MAX_UPLOAD_BYTES, now: now() });
        if ('error' in verdict) return json({ error: verdict.error }, verdict.error === 'identity_witness_too_large' ? 413 : verdict.error === 'identity_witness_invalid' ? 422 : 409);
        write = verdict.write;
        if (sameBytes(store.readHosted(key), stored) && sameBytes(store.readHosted(logKey), log)) break;
        if (attempt >= 2) return json({ error: 'identity_witness_contended' }, 409);
      }
    }
    // A hosted asset log changes only through the verifying submit route (C4): a PUT may create it
    // or repeat it, never change it. A PUT of a line prefix of the stored log is a first publication
    // retried after a shared save landed: already published, so nothing is written and the save is
    // never rolled back (08d review r2 #9).
    if (hosted.kind === 'evidence' && key.endsWith('/originals/asset/did.jsonl')) {
      const stored = store.readHosted(key);
      if (stored && !sameBytes(stored, bytes)) {
        if (isLinePrefix(bytes, stored)) return json({ ok: true, alreadyPublished: true }, 200);
        return json({ error: 'asset_log_changes_through_submit' }, 409);
      }
    }
    // Likewise a retried publication's manifest naming an entry the hosted log has moved past is
    // not written over the manifest of the current head.
    if (hosted.kind === 'evidence' && key.endsWith('/originals/originals-evidence.json') && supersededManifest(bytes, store.readHosted(key.replace(/originals-evidence\.json$/, 'asset/did.jsonl')))) {
      return json({ ok: true, alreadyPublished: true }, 200);
    }
    try {
      store.saveBytes(sub, key, write, contentType);
    } catch (e) {
      return storeError(e);
    }
    return json({ ok: true }, 200);
  }

  async function submit(req: Request, url: URL, clientIp: string): Promise<Response> {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const rl = submitLimiter.check(clientIp);
    if (!rl.allowed) {
      return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) });
    }
    const siteKey = decodeKey(url, SUBMIT_PREFIX);
    const [, ns, , ...rest] = (siteKey ?? '').split('/');
    if (siteKey === null || rest.length > 0 || !ns || !classifyHostedKey(`${siteKey}/originals/asset/did.jsonl`, ns)) {
      return json({ error: 'bad_key' }, 400);
    }
    // Who may submit is decided before the body is read (shared-saves.ts, owner decision of 22 October 2026).
    const caller = { sub, slug: userSlug(sub) };
    const refused = sharedSaves.mayCall(siteKey, caller);
    if (refused) return json(refused.body, refused.http);
    // Counted in bytes as it arrives, declared or chunked (R4).
    const raw = await readBodyCapped(req, MAX_SUBMIT_BYTES);
    if (!raw) return json({ error: 'payload_too_large' }, 413);
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return json({ error: 'bad_request' }, 400);
    }
    const parsed = parseSubmission(body);
    if ('http' in parsed) return json(parsed.body, parsed.http);
    return sharedSaves.submit(siteKey, parsed, caller);
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

  const list: Handler = async (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    try {
      const rows = new Map<string, { did: string; title: string; availability: string }>(store.list(sub).map((o) => [o.did, { ...o, availability: 'incomplete' }]));
      // Discovery reads the caller's durable anchoring tree, even without a
      // separate summary or with the Bitcoin writer disabled (P9.18).
      for (const row of await deps.library?.list(sub) ?? []) rows.set(row.did, { ...rows.get(row.did), ...row });
      return json({ originals: [...rows.values()] }, 200, { 'Cache-Control': 'no-store' });
    } catch { return json({ error: 'library_unavailable', message: 'Your saved work could not be listed. Please retry.' }, 503); }
  };

  const evidence: Handler = async (req, url) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    try {
      const bytes = await deps.library?.evidence(sub, url.searchParams.get('did') ?? '');
      if (!bytes) return json({ error: 'evidence_not_found' }, 404);
      return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: {
        'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="original.originals.zip"',
        'X-Content-Type-Options': 'nosniff',
      } });
    } catch (error) {
      // Two histories and neither chosen (P6.6): said as such, so the opened view can show it.
      if ((error as { code?: string } | null)?.code === 'EVIDENCE_DIVERGED') return json({ error: 'diverged', message: (error as Error).message }, 409);
      return json({ error: 'evidence_unavailable', message: 'This saved evidence needs recovery. No work was removed.' }, 503);
    }
  };

  return { hostPut, hostGet, submit, record, list, evidence, serve: (url) => store.serve(url) };
}
