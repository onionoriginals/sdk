/**
 * U1 — expiry is a UI state, not a raw Turnkey error after the money moved.
 * Two gates: one before a deposit address is offered, one at the inscribe
 * click. Plus the reset rule that must NOT destroy an in-flight Original when
 * re-authentication dips the auth identity through anonymous.
 */
import { describe, test, expect } from 'bun:test';
import { signingGate, signingGateMessage, identityTransition } from './Demo';
import { signOutIntent } from '../auth/sign-out';
import { demo } from '../content';

describe('signingGate', () => {
  const ok = { authenticated: true, hasSigningClient: true, status: 'active' as const };

  test('a signed-in user with a live session may proceed', () => {
    expect(signingGate(ok)).toBe('ok');
  });

  test('an anonymous visitor is asked to sign in, not to re-authenticate', () => {
    expect(signingGate({ ...ok, authenticated: false })).toBe('sign-in');
  });

  test('an expired session is a re-authentication state', () => {
    expect(signingGate({ ...ok, status: 'expired' })).toBe('reauth');
  });

  test('signed in with the signing capability missing (a reload that restored nothing) is re-auth, not ok', () => {
    expect(signingGate({ ...ok, hasSigningClient: false })).toBe('reauth');
    expect(signingGate({ ...ok, status: 'none' })).toBe('reauth');
  });
});

describe('signingGateMessage', () => {
  test('re-authentication speaks in copy from content.ts, never a raw error string', () => {
    const msg = signingGateMessage('reauth', 'mainnet', 'expired');
    expect(msg).toBe(demo.session.expiredBody);
    expect(msg).not.toContain('Error');
    expect(msg).not.toContain('Turnkey');
  });

  test('a browser that never had a signing key is not told its session "expired"', () => {
    expect(signingGateMessage('reauth', 'mainnet', 'none')).toBe(demo.session.missingBody);
  });

  test('sign-in keeps the existing per-network prompt', () => {
    expect(signingGateMessage('sign-in', 'mainnet')).toBe(demo.deposit.signInPrompt);
    expect(signingGateMessage('sign-in', 'testnet4')).toBe(demo.testnet4.signInPrompt);
  });

  test('an ok gate has nothing to say', () => {
    expect(signingGateMessage('ok', 'mainnet')).toBeNull();
  });
});

describe('identityTransition — re-authentication must not destroy the in-flight Original', () => {
  const idle = { active: false, from: null };

  test('no change is a no-op', () => {
    expect(identityTransition('authed:sub-1', 'authed:sub-1', idle)).toBe('none');
  });

  test('a genuine identity change still resets (a different account must not inherit the engine)', () => {
    expect(identityTransition('authed:sub-1', 'authed:sub-2', idle)).toBe('reset');
    expect(identityTransition('anon', 'authed:sub-1', idle)).toBe('reset');
    expect(identityTransition('authed:sub-1', 'anon', idle)).toBe('reset');
  });

  /**
   * FR1 — this used to claim a "full sign-out-and-relogin cycle preserves the
   * asset", built from a hand-made input where `reauth.active` is still true at
   * the moment the identity drops to anonymous. The real `signOut()` never
   * produces that state: React batches its `setUser(null)` with
   * `setReauth({active:false})`, so the identity effect sees anonymous AND an
   * inactive re-auth in ONE render and takes the 'reset' branch. The suite was
   * green on a path that could not happen.
   *
   * The remedy is the guard below, not a rewritten fold: sign-out no longer
   * fires while a refresh is in flight. These two stay as defence in depth for
   * any future path that does drop identity mid-refresh.
   */
  test('mid-refresh identity hops preserve the asset (defence in depth — signOut cannot reach them)', () => {
    const reauth = { active: true, from: 'authed:sub-1' };
    expect(identityTransition('authed:sub-1', 'anon', reauth)).toBe('preserve');
    expect(identityTransition('anon', 'authed:sub-1', reauth)).toBe('preserve');
  });

  test('the state React actually produces on sign-out — anonymous AND re-auth already cleared — resets', () => {
    // Which is exactly why signOut() must not start from here mid-refresh.
    expect(identityTransition('authed:sub-1', 'anon', idle)).toBe('reset');
  });

  test('coming back as a DIFFERENT account during re-auth resets — the Original is not theirs', () => {
    const reauth = { active: true, from: 'authed:sub-1' };
    expect(identityTransition('anon', 'authed:sub-2', reauth)).toBe('reset');
  });
});

/**
 * FR1 — the guard itself, at both the source and the surface. `signOutIntent`
 * is unit-tested in auth/sign-out.test.ts; what this pins is that the nav's
 * Sign out button — the familiar one a stalled creator reaches for instead of
 * finishing the OTP — is gated on the same state.
 */
describe('the Sign out button cannot fire mid signing-session refresh', () => {
  test('the intent at the source is to abandon the refresh, not the Original', () => {
    expect(signOutIntent(true)).toBe('cancel-reauth');
    expect(signOutIntent(false)).toBe('sign-out');
  });

  test('the nav button is disabled while a refresh is in flight, and says why', async () => {
    const source = await Bun.file(new URL('./Nav.tsx', import.meta.url)).text();
    const button = source.slice(source.indexOf('nav-signout'), source.indexOf('nav-signout') + 400);
    expect(button).toContain('disabled={reauth.active}');
    expect(button).toContain('nav.signOutBlocked');
  });
});

/**
 * A signing bootstrap that FAILED is not the same state as a browser that
 * simply has no key yet. Telling someone to "sign in again to get one" when
 * the last sign-in is exactly what failed sends them round a loop that cannot
 * terminate — and does it on the surface where their money is.
 */
describe('signingGate: a failed bootstrap is its own state', () => {
  const base = { authenticated: true, hasSigningClient: false as boolean };

  test('a bootstrap that failed does not read as "no key yet"', () => {
    expect(signingGate({ ...base, status: 'unavailable' })).toBe('unavailable');
    expect(signingGate({ ...base, status: 'none' })).toBe('reauth');
  });

  test('its copy does not tell the user to sign in again', () => {
    const msg = signingGateMessage('unavailable', 'mainnet', 'unavailable');
    expect(msg).toBeTruthy();
    expect(msg!.toLowerCase()).not.toContain('sign in again');
    expect(msg).not.toBe(demo.session.missingBody);
    expect(msg).not.toBe(demo.session.expiredBody);
  });

  test('it still says the money is safe, like every other blocked state', () => {
    const msg = signingGateMessage('unavailable', 'mainnet', 'unavailable')!;
    expect(msg.toLowerCase()).toMatch(/deposit|btc|bitcoin/);
  });

  test('an anonymous visitor is still asked to sign in, whatever the status', () => {
    expect(signingGate({ ...base, authenticated: false, status: 'unavailable' })).toBe('sign-in');
  });

  // #494: when the bootstrap was refused because the token named a key this
  // browser does not hold, the unavailable panel shows THAT reason in place of
  // the generic body. Same source-level pin as the Nav button above.
  test('the unavailable panel prefers the specific signing notice over the generic body', async () => {
    const source = await Bun.file(new URL('./Demo.tsx', import.meta.url)).text();
    const start = source.indexOf("gate === 'unavailable' ? (");
    expect(start).toBeGreaterThan(0);
    const panel = source.slice(start, source.indexOf("gate === 'reauth' ? (", start));
    expect(panel).toContain('signingNotice ?? signingGateMessage(gate, network, signing)');
  });
});
