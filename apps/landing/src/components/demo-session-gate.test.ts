/**
 * U1 — expiry is a UI state, not a raw Turnkey error after the money moved.
 * Two gates: one before a deposit address is offered, one at the inscribe
 * click. Plus the reset rule that must NOT destroy an in-flight Original when
 * re-authentication dips the auth identity through anonymous.
 */
import { describe, test, expect } from 'bun:test';
import { signingGate, signingGateMessage, identityTransition } from './Demo';
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
    expect(signingGateMessage('sign-in', 'testnet4')).toBe(demo.inscribeGate.signInPrompt);
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

  test('a full sign-out-and-relogin re-auth cycle preserves the asset through both hops', () => {
    const reauth = { active: true, from: 'authed:sub-1' };
    // hop 1: signOut() drops the identity to anonymous.
    expect(identityTransition('authed:sub-1', 'anon', reauth)).toBe('preserve');
    // hop 2: the same user comes back.
    expect(identityTransition('anon', 'authed:sub-1', reauth)).toBe('preserve');
  });

  test('coming back as a DIFFERENT account during re-auth resets — the Original is not theirs', () => {
    const reauth = { active: true, from: 'authed:sub-1' };
    expect(identityTransition('anon', 'authed:sub-2', reauth)).toBe('reset');
  });
});
