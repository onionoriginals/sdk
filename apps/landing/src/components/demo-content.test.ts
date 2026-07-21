import { describe, test, expect } from 'bun:test';
import { demo } from '../content';

describe('demo resolved-DID copy', () => {
  test('has a resolved-DID label block', () => {
    expect(demo.resolved).toBeDefined();
    expect(typeof demo.resolved.heading).toBe('string');
    expect(demo.resolved.heading.length).toBeGreaterThan(0);
    expect(typeof demo.resolved.resolvedBadge).toBe('string');
    expect(typeof demo.resolved.pendingBadge).toBe('string');
    expect(typeof demo.resolved.linkLabel).toBe('string');
  });
});
