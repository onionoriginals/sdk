import { describe, test, expect } from 'bun:test';
import { developers, hero, nav } from './content';

/**
 * The landing page speaks to creators first (landing-page punch list, 2026-08).
 * These tests pin the copy decisions that are easy to regress: the hero and nav
 * route people to the product flow (interim target: #demo, until the
 * creator-app upload flow ships), and the Developers section carries the only
 * install/docs material — the hero stays free of library marketing.
 */

describe('creator-first hero', () => {
  test('primary CTA targets the product flow, not the developer section', () => {
    expect(hero.primaryCta.href).toBe('#demo');
    expect(hero.primaryCta.label.length).toBeGreaterThan(0);
  });

  test('quiet link points at the real Original instead of an install hint', () => {
    expect(hero.exampleLink.href).toBe('#example');
    expect('installHint' in hero).toBe(false);
  });
});

describe('creator-first nav', () => {
  test('CTA targets the product flow', () => {
    expect(nav.cta.href).toBe('#demo');
  });

  test('the demo link invites trying, not watching a demo', () => {
    const demoLink = nav.links.find((l) => l.href === '#demo');
    expect(demoLink).toBeDefined();
    expect(demoLink!.label).toBe('Try it');
  });
});

describe('slimmed Developers section', () => {
  test('keeps install + a docs pointer, drops the inline quickstart', () => {
    expect(typeof developers.sdkNote).toBe('string');
    expect(developers.sdkNote).toContain('@originals/sdk');
    expect(developers.docsLink.href).toContain('github.com/onionoriginals/sdk');
    expect('quickstart' in developers).toBe(false);
    expect('eventsSnippet' in developers).toBe(false);
  });
});
