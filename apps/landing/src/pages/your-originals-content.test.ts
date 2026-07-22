import { describe, test, expect } from 'bun:test';
import { yourOriginals, originalDetail } from '../content';

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
    expect(typeof yourOriginals.viewLabel).toBe('string');
  });
});

describe('originalDetail copy', () => {
  test('has the strings the detail page renders', () => {
    expect(typeof originalDetail.backLabel).toBe('string');
    expect(typeof originalDetail.signedOut).toBe('string');
    expect(typeof originalDetail.loading).toBe('string');
    expect(typeof originalDetail.notFoundTitle).toBe('string');
    expect(typeof originalDetail.notFoundCta).toBe('string');
    expect(typeof originalDetail.verifiedBadge).toBe('string');
    expect(typeof originalDetail.verifyingBadge).toBe('string');
    expect(typeof originalDetail.failedBadge).toBe('string');
    expect(typeof originalDetail.checkLabels.hash).toBe('string');
    expect(typeof originalDetail.checkLabels.log).toBe('string');
    expect(typeof originalDetail.checkLabels.cel).toBe('string');
  });
  test('has a titled step for each lifecycle layer', () => {
    for (const id of ['create', 'publish', 'inscribe'] as const) {
      expect(originalDetail.timeline.steps[id].title.length).toBeGreaterThan(0);
      expect(originalDetail.timeline.steps[id].blurb.length).toBeGreaterThan(0);
    }
  });
  test('has the section headings', () => {
    expect(originalDetail.timeline.heading.length).toBeGreaterThan(0);
    expect(originalDetail.resources.heading.length).toBeGreaterThan(0);
    expect(originalDetail.identity.heading.length).toBeGreaterThan(0);
    expect(originalDetail.artifacts.heading.length).toBeGreaterThan(0);
  });
});
