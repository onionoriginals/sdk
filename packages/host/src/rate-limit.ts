// In-memory sliding-window limiter. Single-process only (dev/test); not distributed.
//
// The key space is BOUNDED. Limiters now key on a per-client identity
// (client-ip.ts) rather than one shared socket peer, and the host-write route
// is unauthenticated, so a distributed or IPv6-rotating flood would otherwise
// grow this map without limit on a single-instance server. Eviction is
// least-recently-seen first: the Map is kept in access order, so the keys that
// go are the ones that stopped asking — a client mid-flood keeps its bucket.
const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }) {
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  const hits = new Map<string, number[]>();

  // Re-insert at the tail so Map iteration order IS least-recently-seen first.
  function touch(key: string, times: number[]): void {
    hits.delete(key);
    hits.set(key, times);
    if (hits.size <= maxKeys) return;
    for (const k of hits.keys()) {
      if (hits.size <= maxKeys) break;
      hits.delete(k);
    }
  }

  return {
    check(key: string): { allowed: boolean; retryAfterMs: number } {
      const now = Date.now();
      const cutoff = now - opts.windowMs;
      const times = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (times.length >= opts.limit) {
        const retryAfterMs = times[0] + opts.windowMs - now;
        touch(key, times);
        return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1) };
      }
      times.push(now);
      touch(key, times);
      return { allowed: true, retryAfterMs: 0 };
    },
    /** Tracked key count — for tests and any future memory reporting. */
    size(): number {
      return hits.size;
    },
  };
}
