/**
 * In-memory WebVH host: receives the SDK's hosting writes at PUT /api/host/<key>
 * and serves them back at the EXACT URLs didwebvh-ts's resolver GETs.
 *
 * The put key is `${domain}/${relativePath}` (LifecycleManager). The resolver
 * GETs https://${domain}/${relativePath}, so on serve the lookup key is
 * `${url.host}${url.pathname}` — byte-identical to the put key. Bounded by a
 * per-object size cap, a total-entry cap, and a TTL; PUTs are rate-limited.
 */
import { json } from './router';
import { createRateLimiter } from './rate-limit';

interface Entry {
  body: Uint8Array;
  contentType: string;
  expiresAt: number;
}

const HOST_PREFIX = '/api/host/';

export function createWebvhHostStore(opts?: {
  maxObjectBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
  limit?: number;
  windowMs?: number;
}) {
  const maxObjectBytes = opts?.maxObjectBytes ?? 256 * 1024; // 256 KiB per object
  const maxEntries = opts?.maxEntries ?? 500;
  const ttlMs = opts?.ttlMs ?? 30 * 60 * 1000; // 30 minutes
  const now = opts?.now ?? Date.now;
  const limiter = createRateLimiter({
    limit: opts?.limit ?? 120,
    windowMs: opts?.windowMs ?? 60_000,
  });

  const map = new Map<string, Entry>();

  function sweep(): void {
    const t = now();
    for (const [k, e] of map) if (e.expiresAt <= t) map.delete(k);
  }

  function clientIp(req: Request): string {
    return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  }

  async function handlePut(req: Request, url: URL): Promise<Response> {
    if (req.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);

    const rl = limiter.check(clientIp(req));
    if (!rl.allowed) {
      return json({ error: 'rate_limited' }, 429, {
        'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
      });
    }

    const key = decodeURIComponent(url.pathname.slice(HOST_PREFIX.length));
    if (!key) return json({ error: 'missing_key' }, 400);

    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > maxObjectBytes) {
      return json({ error: 'too_large', maxObjectBytes }, 413);
    }

    sweep();
    if (!map.has(key) && map.size >= maxEntries) {
      return json({ error: 'store_full', maxEntries }, 507);
    }

    map.set(key, {
      body,
      contentType: req.headers.get('content-type') ?? 'application/octet-stream',
      expiresAt: now() + ttlMs,
    });
    return json({ ok: true }, 200);
  }

  function serve(_req: Request, url: URL): Response | null {
    sweep();
    const key = `${url.host}${url.pathname}`;
    const entry = map.get(key);
    if (!entry) return null;
    // Copy so the caller can't mutate stored bytes.
    // The store is unauthenticated (public demo — must run without secrets), so
    // content is untrusted. Neutralize stored-XSS: nosniff + a sandbox CSP +
    // attachment disposition mean a browser never executes served bytes as a
    // page regardless of their content-type. did:webvh resolution is unaffected
    // — it reads the log via fetch(), where these headers don't apply.
    return new Response(entry.body.slice(), {
      status: 200,
      headers: {
        'content-type': entry.contentType,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': 'attachment',
      },
    });
  }

  return { handlePut, serve, size: () => map.size };
}
