import { describe, test, expect } from 'bun:test';
import { demo, legal, library } from '../content';
import { publishDurabilityNote, publishStepLock, resolvedCopy, stepButtonDisabled } from './demo-logic';

// #976 B5, gap G10; owner decision of 23 October 2026 (#992, #996). Signed
// out, the Original is signed with a guest key kept in this browser,
// unencrypted, so anyone using the browser can sign as that guest. One
// warning says so (library.guestKey, rendered once: pages/guest-key-copy.test.tsx);
// nothing promises a backup or an anonymous publication that doesn't exist.
const privacyText = JSON.stringify(legal);

describe('signed-out copy is explicit about the kept guest key', () => {
  test('the one guest-key warning says it is stored here, unencrypted, and who can sign', () => {
    expect(library.guestKey).toMatch(/stored in this browser, unencrypted/);
    expect(library.guestKey).toMatch(/Anyone using this browser can sign as this guest/);
    expect(library.guestKey).toMatch(/Sign in to sign with your own key/);
  });

  test('the publish-step note does not repeat the warning; it says publishing needs sign-in', () => {
    const note = demo.hosting.temporaryNote;
    expect(note).toMatch(/Publishing needs sign-in/);
    expect(note).not.toMatch(/unencrypted|anyone using this browser|discard|shared demo area|couple of hours/i);
  });

  test('privacy copy claims no key in localStorage, no backup file and no anonymous publishing', () => {
    expect(privacyText).not.toMatch(/lives in this browser’s localStorage/);
    expect(privacyText).not.toMatch(/backup file/i);
    expect(privacyText).not.toMatch(/What it publishes goes to an in-memory store/);
    expect(privacyText).not.toMatch(/discarded with it/);
    expect(privacyText).toMatch(/unencrypted/);
    expect(privacyText).toMatch(/Anyone who uses this browser can read them and sign as this guest/);
  });

  test('no signed-out heading says the history is available here', () => {
    expect(resolvedCopy(false).heading).not.toMatch(/available here for now/i);
  });
});

// B5: "Publishing isn't available signed out", in the production build
// (hostedPublication off) and in the staging acceptance build (on).
describe('signed out, publishing is locked in both builds', () => {
  for (const hostedPublication of [false, true]) {
    test(`hostedPublication ${hostedPublication}: the step is locked`, () => {
      expect(publishStepLock({ hostedPublication, authenticated: false })).not.toBeNull();
    });
  }

  test('the sign-in-to-publish note shows only where publishing exists', () => {
    expect(publishDurabilityNote(false, true)).toBe(demo.hosting.temporaryNote);
    expect(publishDurabilityNote(false, false)).toBeNull();
  });

  test('a signed-out publish button is never clickable, even when ready', () => {
    const ready = { index: 1, state: 'ready' as const, titleEmpty: false, pendingRevision: false, updating: false };
    expect(stepButtonDisabled({ ...ready, authenticated: false })).toBe(true);
    expect(stepButtonDisabled({ ...ready, authenticated: true })).toBe(false);
  });

  test('signed in, the lock follows the build flag alone, and there is no signed-out note', () => {
    expect(publishStepLock({ hostedPublication: true, authenticated: true })).toBeNull();
    expect(publishStepLock({ hostedPublication: false, authenticated: true })).toBe('unavailable');
    expect(publishDurabilityNote(true, true)).toBeNull();
    expect(publishDurabilityNote(true, false)).toBeNull();
  });

  test('with publication off for everyone, the reason given is that, not sign-in', () => {
    expect(publishStepLock({ hostedPublication: false, authenticated: false })).toBe('unavailable');
    expect(publishStepLock({ hostedPublication: true, authenticated: false })).toBe('signed-out');
  });
});
