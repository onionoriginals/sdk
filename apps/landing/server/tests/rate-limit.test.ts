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
});
