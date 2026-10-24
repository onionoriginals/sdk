/**
 * Owner decision, 23 October 2026: the guest author's key stays in this
 * browser's IndexedDB, unencrypted and shared by everyone using the browser
 * profile. That is accepted, and said plainly wherever guest mode is shown.
 */
import { expect, test } from 'bun:test';
import { library } from '../content';

const source = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test('the guest key warning says who can sign and how to sign with your own key', () => {
  expect(library.guestKey).toContain('stored in this browser');
  expect(library.guestKey).toContain('Anyone using this browser can sign as this guest author');
  expect(library.guestKey).toContain('Sign in to sign with your own key');
});

test('Your Originals and the demo show the warning in guest mode only', async () => {
  expect(await source('./YourOriginals.tsx')).toMatch(/\{!account && <p>\{copy\.guestKey\}<\/p>\}/);
  expect(await source('../components/Demo.tsx')).toMatch(/\{!isAuthenticated && <p[^>]*>\{libraryCopy\.guestKey\}<\/p>\}/);
});
