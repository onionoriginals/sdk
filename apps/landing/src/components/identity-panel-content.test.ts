/**
 * U5 / R9 — the identity panel sits in the hero of the signed-in page and used
 * to say "Your identity is live" and "Anchored to your keys. Resolvable
 * anywhere DIDs are." for a DID that is created, displayed, and then written
 * to `localStorage` under a domain this app does not serve (see the header
 * comment in `src/auth/webvh.ts`, and `createUserWebVHDid`, which persists the
 * log and hosts nothing). Nothing can resolve it.
 */
import { describe, test, expect } from 'bun:test';
import { identityPanel } from '../content';

/** Every string the panel renders, including the nested U10 blocks. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

const rendered = strings(identityPanel);

describe('identity panel copy', () => {
  test('every string the panel renders comes from content.ts', () => {
    for (const key of [
      'layerLabel', 'idleTitle', 'idleBody', 'createAction', 'creating', 'createFailed',
      'doneTitle', 'doneNote', 'copy', 'copied', 'copyAria', 'copiedAria',
    ] as const) {
      expect(typeof identityPanel[key]).toBe('string');
      expect(identityPanel[key].length).toBeGreaterThan(0);
    }
  });

  test('it claims neither hosting nor resolvability for a browser-local DID', () => {
    for (const value of rendered) {
      expect(value).not.toMatch(/\blive\b|hosted|resolvab|resolves|anywhere DIDs|on the open web/i);
    }
  });

  test('it says where the DID actually is', () => {
    expect(`${identityPanel.idleBody} ${identityPanel.doneNote}`).toMatch(/browser/i);
    expect(identityPanel.doneNote).toMatch(/not published|isn’t published|isn't published/i);
  });

  test('it hands the visitor no URL for something that would not load', () => {
    for (const value of rendered) expect(value).not.toMatch(/https?:\/\//);
  });

  /**
   * U10 / R17 — the warning has to arrive BEFORE the key exists (the panel
   * gates creating on `warning.acknowledge`, and `webvh.ts` refuses to mint a
   * key until it is recorded), then again for a returning user.
   */
  test('the pre-creation warning names the loss and offers no recovery', () => {
    const warning = `${identityPanel.warning.title} ${identityPanel.warning.body}`;
    expect(warning).toMatch(/only this browser|this browser/i);
    expect(identityPanel.warning.body).toMatch(/cleared|clearing/i);
    expect(identityPanel.warning.body).toMatch(/gone|cannot|can’t|no one can/i);
    expect(identityPanel.warning.acknowledge).toMatch(/only in this browser/i);
    expect(identityPanel.warning.remedy).toMatch(/backup/i);
  });

  test('the returning-user reminder restates it on the identity panel', () => {
    expect(identityPanel.warning.reminder).toMatch(/this browser/i);
    expect(identityPanel.warning.reminder).toMatch(/clearing|evict/i);
  });

  /** R18 — the export half must say the passphrase is unrecoverable. */
  test('the backup copy is honest about the passphrase being final', () => {
    expect(identityPanel.backup.body).toMatch(/passphrase/i);
    expect(identityPanel.backup.body).toMatch(/reset|cannot|can’t|no one/i);
  });

  test('the restore copy warns before a replacement, and promises no upload', () => {
    expect(identityPanel.restore.replaceTitle).toMatch(/different key/i);
    expect(identityPanel.restore.replaceBody).toMatch(/replaces|replaced/i);
    expect(identityPanel.restore.body).toMatch(/never sent|in your browser/i);
  });
});
