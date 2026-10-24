/**
 * How /me/<did> reads the account's evidence: a divergence (409) is said as
 * such, never shown as "nothing saved" (#996 review; P6.6).
 */
import { afterEach, expect, test } from 'bun:test';
import { fetchLibraryEvidence } from './library';
import { library } from '../content';

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });
const answer = (response: Response) => { globalThis.fetch = (async () => response) as unknown as typeof fetch; };

test('409 diverged throws the server\'s message', async () => {
  answer(new Response(JSON.stringify({ error: 'diverged', message: 'Two copies disagree.' }), { status: 409 }));
  await expect(fetchLibraryEvidence('did:vh:x')).rejects.toThrow('Two copies disagree.');
});

test('409 without a message still says the copies disagree', async () => {
  answer(new Response('{}', { status: 409 }));
  await expect(fetchLibraryEvidence('did:vh:x')).rejects.toThrow(library.diverged);
});

test('404 is no account copy, not an error', async () => {
  answer(new Response('{}', { status: 404 }));
  expect(await fetchLibraryEvidence('did:vh:x')).toBeNull();
});
