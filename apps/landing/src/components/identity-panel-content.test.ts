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

const rendered = Object.values(identityPanel);

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
});
