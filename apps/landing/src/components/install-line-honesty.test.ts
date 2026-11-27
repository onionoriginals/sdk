import { describe, test, expect } from 'bun:test';
import { site, developers } from '../content';
import sdk from '../../../../packages/sdk/package.json';

/**
 * npm's `latest` for @originals/sdk is 6.2.0, the release this page runs, so a
 * plain `npm install @originals/sdk` hands a developer the SDK they just watched
 * run. The `next` tag still points at 3.0.0-next.1, an old pre-release with no
 * `./og` export, so the install line must never use it.
 *
 * These assertions fail if the install line picks up a tag again, or if the
 * SDK moves to another release without the version note following it.
 */
const LATEST = '6.2.0';

describe('install line names the version the page actually describes', () => {
  test('the install command is a plain, untagged install of latest', () => {
    expect(site.install.trim()).toBe('npm install @originals/sdk');
  });

  test('it never installs the stale next tag', () => {
    expect(site.install).not.toContain('@next');
  });

  test('the page says which release latest is', () => {
    expect(developers.versionNote).toBeTruthy();
    expect(developers.versionNote).toContain(LATEST);
    expect(developers.versionNote.toLowerCase()).toContain('latest');
  });

  test('the release the note names is the SDK this page runs', () => {
    expect(sdk.version).toBe(LATEST);
  });
});
