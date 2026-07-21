import { describe, test, expect } from 'bun:test';
import { demo } from '../content';

describe('inscribe coming-soon copy', () => {
  test('has a comingSoon string', () => {
    expect(typeof demo.comingSoon).toBe('string');
    expect(demo.comingSoon.length).toBeGreaterThan(0);
  });
  test('the inscribe step (steps[2]) reads as coming soon, not a live inscription', () => {
    expect(demo.steps[2].description.toLowerCase()).toContain('coming');
    expect(demo.steps[2].description).not.toContain('Runs the commit/reveal inscription flow');
  });
});
