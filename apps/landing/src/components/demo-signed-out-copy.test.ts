import { describe, test, expect } from 'bun:test';
import { demo, legal } from '../content';

// #976 B5. Signed out, the Original is signed by a key made in the page and
// discarded with it. The copy says so, and promises no storage, backup or
// anonymous publication that doesn't exist.
const privacyText = JSON.stringify(legal);

describe('signed-out copy is explicit about the discarded key', () => {
  test('the publish-step note says the key is discarded and points to sign-in', () => {
    const note = demo.hosting.temporaryNote;
    expect(note).toMatch(/discard/i);
    expect(note).toMatch(/sign in/i);
    expect(note).not.toMatch(/shared demo area|couple of hours/i);
  });

  test('privacy copy claims no key in localStorage and no backup file', () => {
    expect(privacyText).not.toMatch(/lives in this browser’s localStorage/);
    expect(privacyText).not.toMatch(/backup file/i);
    expect(privacyText).toMatch(/generated in the page and discarded with it/);
  });
});
