import { describe, test, expect } from 'bun:test';
import { createRateLimiter } from '../rate-limit';

describe('rate-limit', () => {
  test('allows up to limit then blocks', () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    const third = rl.check('a');
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  test('keys are independent', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('b').allowed).toBe(true);
  });

  // U7 makes the unauthenticated host-write limiter key on the CLIENT rather
  // than on one shared socket peer, so a distributed (or IPv6-rotating) flood
  // can now introduce unbounded distinct keys on a single-instance server.
  test('key count is bounded — a flood of distinct keys does not grow forever', () => {
    const rl = createRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 50 });
    for (let i = 0; i < 5000; i++) rl.check(`flood-${i}`);
    expect(rl.size()).toBeLessThanOrEqual(50);
  });

  test('eviction drops the least recently seen key, not the active one', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    expect(rl.check('active').allowed).toBe(true); // seeds the bucket
    rl.check('stale');
    rl.check('active'); // touch it again → most recently used
    rl.check('newcomer'); // over the cap → evicts 'stale'
    expect(rl.size()).toBeLessThanOrEqual(2);
    // 'active' kept its bucket, so it is still limited.
    expect(rl.check('active').allowed).toBe(false);
  });
});
