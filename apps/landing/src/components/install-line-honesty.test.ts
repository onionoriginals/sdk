import { describe, test, expect } from 'bun:test';
import { site, developers } from '../content';

/**
 * npm's `latest` for @originals/sdk is 2.1.0 — a major behind the SDK this page
 * demonstrates. A bare `npm install @originals/sdk` therefore hands a developer
 * a different library than the one they just watched run: no did:cel, no CEL
 * event log, no `./testing` subpath for the mock provider the bullets promise.
 *
 * These assertions fail if the install line drifts back to an untagged install
 * while the page still describes 3.x. Drop them when 3.0.0 is on `latest`.
 */
describe('install line names the version the page actually describes', () => {
  test('the install command carries an explicit tag or version', () => {
    expect(site.install).toContain('@originals/sdk@');
  });

  test('it is not a bare untagged install', () => {
    expect(site.install.trim()).not.toBe('npm install @originals/sdk');
  });

  test('the page says which line it is describing', () => {
    expect(developers.versionNote).toBeTruthy();
    expect(developers.versionNote.toLowerCase()).toContain('next');
  });

  test('the tag in the install line and the version note agree', () => {
    const tag = site.install.split('@originals/sdk@')[1]?.trim();
    expect(tag).toBeTruthy();
    expect(developers.versionNote.toLowerCase()).toContain(tag.toLowerCase());
  });
});
