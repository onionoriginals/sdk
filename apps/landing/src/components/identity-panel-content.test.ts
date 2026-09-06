/**
 * The identity panel's copy, against the custody model it now describes.
 *
 * This file used to assert the OPPOSITE of most of what it asserts now: the
 * DID was signed by a browser-local key and hosted nowhere, so the copy was
 * forbidden from saying "resolvable" and required to say "this browser". The
 * key moved to Turnkey and the log is published (see `auth/webvh.ts`), so the
 * honest claims inverted — and the one that must never come back is the old
 * promise that we never hold a copy of the key.
 */
import { describe, test, expect } from 'bun:test';
import { identityPanel } from '../content';

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
      'doneTitle', 'doneNote', 'custodyNote', 'sessionRequired',
      'copy', 'copied', 'copyAria', 'copiedAria',
    ] as const) {
      expect(typeof identityPanel[key]).toBe('string');
      expect(identityPanel[key].length).toBeGreaterThan(0);
    }
  });

  /**
   * The load-bearing one. Custody is a downgrade from what this panel used to
   * promise, so it must be stated on the panel itself — naming the custodian,
   * not hedged into "a key held for you".
   */
  test('it names the custodian rather than implying self-custody', () => {
    expect(`${identityPanel.doneNote} ${identityPanel.custodyNote}`).toMatch(/Turnkey/);
    expect(identityPanel.custodyNote).toMatch(/holds the key|custody/i);
  });

  test('it never repeats the old promise that no one else holds the key', () => {
    for (const value of rendered) {
      expect(value).not.toMatch(/never get a copy|only you (hold|have)|we cannot sign|no one else/i);
      expect(value).not.toMatch(/only this browser/i);
    }
  });

  /** Custody's actual selling point: nothing to write down, nothing to lose. */
  test('it sells the benefit that replaces the warning it removed', () => {
    const pitch = `${identityPanel.idleTitle} ${identityPanel.idleBody} ${identityPanel.doneNote}`;
    expect(pitch).toMatch(/no seed phrase|nothing to write down|no key to lose|nothing to back up/i);
    expect(pitch).toMatch(/sign(ing)? in|any (browser|device)/i);
  });

  /** The log IS published now, so portability is a claim we may finally make. */
  test('it claims the portability the published log actually provides', () => {
    expect(identityPanel.doneNote).toMatch(/comes back|any browser|any device/i);
  });

  test('it offers the self-custody alternative rather than hiding it', () => {
    expect(identityPanel.custodyNote).toMatch(/SDK|your own/i);
  });

  test('it hands the visitor no URL for something that would not load', () => {
    for (const value of rendered) expect(value).not.toMatch(/https?:\/\//);
  });
});
