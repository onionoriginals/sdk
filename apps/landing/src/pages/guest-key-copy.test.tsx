/**
 * Owner decision, 23 October 2026: the guest author's key stays in this
 * browser's IndexedDB, unencrypted and shared by everyone using the browser
 * profile. That is accepted, and said plainly, once, wherever guest mode is
 * shown. Rendered, not read from source.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { library } from '../content';
import { AuthProvider } from '../auth/useAuth';
import { Demo } from '../components/Demo';
import { AccountLibrary, LibraryEntry } from './YourOriginals';

const g = globalThis as { location?: unknown };
const saved = g.location;
const at = (pathname: string) => { g.location = { pathname, href: `http://landing.test${pathname}`, origin: 'http://landing.test', search: '', hash: '' }; };
beforeAll(() => at('/me'));
afterAll(() => { g.location = saved; });

const count = (html: string, text: string) => html.split(text).length - 1;

test('the guest key warning says who can sign and how to sign with your own key', () => {
  expect(library.guestKey).toContain('stored in this browser');
  expect(library.guestKey).toContain('Anyone using this browser can sign as this guest author');
  expect(library.guestKey).toContain('Sign in to sign with your own key');
});

test('Your Originals shows it to a guest, not to a signed-in account', () => {
  expect(count(renderToStaticMarkup(createElement(AccountLibrary, {})), library.guestKey)).toBe(1);
  expect(count(renderToStaticMarkup(createElement(AccountLibrary, { account: 'sub-1' })), library.guestKey)).toBe(0);
});

test('the signed-out demo shows it once; on /me/<did> the library already does, so the demo does not repeat it', () => {
  at('/');
  expect(count(renderToStaticMarkup(createElement(AuthProvider, null, createElement(Demo))), library.guestKey)).toBe(1);
  at('/me/did%3Avh%3Ax');
  const opened = renderToStaticMarkup(createElement(AuthProvider, null, createElement(AccountLibrary, {})));
  expect(opened).toContain(library.opening); // the opened Original's demo is on the page
  expect(count(opened, library.guestKey)).toBe(1);
  at('/me');
});

test('a record whose DID cannot be trusted is shown with its problem and is not a link (#996 review)', () => {
  const html = renderToStaticMarkup(createElement(LibraryEntry, { item: { did: 'unknown:abc', title: 'Original needing recovery', local: false, server: false, pending: false, problem: 'Saved evidence could not be read.' } }));
  expect(html).not.toContain('<a');
  expect(html).toContain('Saved evidence could not be read.');
  const good = renderToStaticMarkup(createElement(LibraryEntry, { item: { did: 'did:vh:x', title: 'Harbor', local: true, server: false, pending: false } }));
  expect(good).toContain('<a');
});
