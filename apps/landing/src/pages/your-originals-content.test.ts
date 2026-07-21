import { describe, test, expect } from 'bun:test';
import { yourOriginals } from '../content';

describe('yourOriginals copy', () => {
  test('has the strings the page renders', () => {
    expect(yourOriginals).toBeDefined();
    expect(typeof yourOriginals.heading).toBe('string');
    expect(yourOriginals.heading.length).toBeGreaterThan(0);
    expect(typeof yourOriginals.signedOut).toBe('string');
    expect(typeof yourOriginals.emptyTitle).toBe('string');
    expect(typeof yourOriginals.emptyCta).toBe('string');
    expect(typeof yourOriginals.resolvedBadge).toBe('string');
    expect(typeof yourOriginals.pendingBadge).toBe('string');
    expect(typeof yourOriginals.openLog).toBe('string');
    expect(typeof yourOriginals.navLabel).toBe('string');
  });
});
