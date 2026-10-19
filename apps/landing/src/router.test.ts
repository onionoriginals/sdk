import { describe, test, expect } from 'bun:test';
import { routeForPath } from './router';

describe('routeForPath', () => {
  test('/ → landing', () => {
    expect(routeForPath('/')).toBe('landing');
  });

  test('/privacy and /terms → their own routes', () => {
    expect(routeForPath('/privacy')).toBe('privacy');
    expect(routeForPath('/terms')).toBe('terms');
  });

  test('a near-miss legal path → landing', () => {
    expect(routeForPath('/privacy/')).toBe('landing');
    expect(routeForPath('/terms-of-use')).toBe('landing');
  });

  // Explore and Your Originals return with web publication and Bitcoin
  // anchoring on the Originals Protocol (plan 011, PRs 8 and 10).
  test('/explore and /me paths fall through to the landing page for now', () => {
    for (const path of ['/explore', '/explore/did%3Avh%3Ax', '/me', '/me/did%3Avh%3Ax']) {
      expect(routeForPath(path)).toBe('landing');
    }
  });

  test('unknown path → landing (SPA fallback)', () => {
    expect(routeForPath('/nope')).toBe('landing');
  });
});
