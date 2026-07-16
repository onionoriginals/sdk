// In-memory sliding-window limiter. Single-process only (dev/test); not distributed.
export function createRateLimiter(opts: { limit: number; windowMs: number }) {
  const hits = new Map<string, number[]>();
  return {
    check(key: string): { allowed: boolean; retryAfterMs: number } {
      const now = Date.now();
      const cutoff = now - opts.windowMs;
      const times = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (times.length >= opts.limit) {
        const retryAfterMs = times[0] + opts.windowMs - now;
        hits.set(key, times);
        return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1) };
      }
      times.push(now);
      hits.set(key, times);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}
