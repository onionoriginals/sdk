import { describe, test, expect } from 'bun:test';
import { demo, legal } from '../content';
import { publishDurabilityNote, publishStepLock, resolvedCopy, stepButtonDisabled } from './demo-logic';

// #976 B5, gap G10. Signed out, the Original is signed by a key made in the
// page and discarded with it. The copy says so, and promises no storage,
// backup or anonymous publication that doesn't exist.
const privacyText = JSON.stringify(legal);

describe('signed-out copy is explicit about the discarded key', () => {
  test('the publish-step note says the key is discarded and points to sign-in', () => {
    const note = demo.hosting.temporaryNote;
    expect(note).toMatch(/discard/i);
    expect(note).toMatch(/sign in/i);
    expect(note).not.toMatch(/shared demo area|couple of hours/i);
  });

  test('privacy copy claims no key in localStorage, no backup file and no anonymous publishing', () => {
    expect(privacyText).not.toMatch(/lives in this browser’s localStorage/);
    expect(privacyText).not.toMatch(/backup file/i);
    expect(privacyText).not.toMatch(/What it publishes goes to an in-memory store/);
    expect(privacyText).toMatch(/generated in the page and discarded with it/);
  });

  test('no signed-out heading says the history is available here', () => {
    expect(resolvedCopy(false).heading).not.toMatch(/available here for now/i);
  });
});

// B5: "Publishing isn't available signed out", in the production build
// (hostedPublication off) and in the staging acceptance build (on).
describe('signed out, publishing is locked and the G10 note shows in both builds', () => {
  for (const hostedPublication of [false, true]) {
    test(`hostedPublication ${hostedPublication}: the step is locked and the note says the key is discarded`, () => {
      expect(publishStepLock({ hostedPublication, authenticated: false })).not.toBeNull();
      const note = publishDurabilityNote(false, hostedPublication);
      expect(note).toMatch(/discard/i);
      expect(note).not.toMatch(/shared demo area|couple of hours/i);
    });
  }

  test('the production note does not invite a publish that no build offers', () => {
    expect(publishDurabilityNote(false, false)).not.toMatch(/publish/i);
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
