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

  // Private recovery does not depend on public Explore or publication gates.
  test('/explore remains off', () => {
    for (const path of ['/explore', '/explore/did%3Avh%3Ax']) {
      expect(routeForPath(path)).toBe('landing');
    }
  });

  test('Your Originals has a private list and reopen route', () => {
    expect(routeForPath('/me')).toBe('originals');
    expect(routeForPath('/me/did%3Avh%3Ax')).toBe('originals');
  });

  test('unknown path → landing (SPA fallback)', () => {
    expect(routeForPath('/nope')).toBe('landing');
  });
});
