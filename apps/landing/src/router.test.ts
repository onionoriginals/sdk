import { describe, test, expect } from 'bun:test';
import { routeForPath } from './router';

describe('routeForPath', () => {
  test('/ → landing', () => {
    expect(routeForPath('/')).toBe('landing');
  });
  test('/me → your-originals', () => {
    expect(routeForPath('/me')).toBe('your-originals');
  });
  test('unknown path → landing (SPA fallback)', () => {
    expect(routeForPath('/anything/else')).toBe('landing');
  });
});
