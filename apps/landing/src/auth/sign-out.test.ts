/**
 * SEC-3 / FR1 — what sign-out must do, independent of what it could read.
 *
 * The erase of the 12-hour non-extractable signing key is the whole point of
 * signing out on a shared machine, so it cannot be conditional on the session
 * METADATA being readable: storage denied (Safari private mode), a quota
 * failure after OTP_LOGIN already succeeded, or an unreadable `user` all leave
 * `meta === null` while a live credential sits in IndexedDB.
 */
import { describe, test, expect } from 'bun:test';
import { endSigningSession, signOutIntent } from './sign-out';
import type { SigningSessionMeta } from './turnkey-session';
import { demo } from '../content';

const META: SigningSessionMeta = {
  subOrgId: 'sub-1',
  publicKey: '02'.padEnd(66, 'a'),
  expiresAt: Date.now() + 3_600_000,
};

/** Records what sign-out did to the browser-held key. */
function stubKey(opts: { openThrows?: boolean; clearThrows?: boolean } = {}) {
  const calls = { opened: [] as string[], cleared: 0 };
  return {
    calls,
    openSessionKey: async (subOrgId = '') => {
      calls.opened.push(subOrgId);
      if (opts.openThrows) throw new Error('IndexedDB unavailable');
      return {
        client: {},
        clear: async () => {
          if (opts.clearThrows) throw new Error('clear failed');
          calls.cleared++;
        },
      };
    },
  };
}

const revoked = async () => 'revoked' as const;
const revokeFails = async () => 'revoke-failed' as const;

describe('endSigningSession erases unconditionally', () => {
  test('a readable session is revoked AND erased', async () => {
    const key = stubKey();
    const notice = await endSigningSession({
      meta: META,
      fallbackSubOrgId: null,
      openSessionKey: key.openSessionKey,
      revokeSessionKey: revoked,
    });
    expect(key.calls.cleared).toBe(1);
    expect(notice).toBeNull();
  });

  test('UNREADABLE metadata still erases the key — storage denied must not leave a live signer', async () => {
    // Before this fix the whole revoke-and-erase block sat behind `if (meta)`,
    // so a browser that denies localStorage signed out with a credential that
    // could still sign mainnet Bitcoin for another 12 hours.
    const key = stubKey();
    await endSigningSession({
      meta: null,
      fallbackSubOrgId: 'sub-1',
      openSessionKey: key.openSessionKey,
      revokeSessionKey: revoked,
    });
    expect(key.calls.cleared).toBe(1);
  });

  test('no metadata and no user still erases — the key is per-browser, not per-org', async () => {
    const key = stubKey();
    await endSigningSession({
      meta: null,
      fallbackSubOrgId: null,
      openSessionKey: key.openSessionKey,
      revokeSessionKey: revoked,
    });
    expect(key.calls.cleared).toBe(1);
  });

  test('revocation is attempted from the user’s sub-org when the metadata is gone', async () => {
    const key = stubKey();
    const seen: string[] = [];
    await endSigningSession({
      meta: null,
      fallbackSubOrgId: 'sub-9',
      openSessionKey: key.openSessionKey,
      revokeSessionKey: async (_api, meta) => {
        seen.push(meta.subOrgId);
        return 'revoked';
      },
    });
    expect(key.calls.opened).toContain('sub-9');
    // Nothing to revoke without a recorded public key, so revocation is
    // skipped rather than guessed at — the erase above is what matters.
    expect(seen).toEqual([]);
  });

  test('a failed revocation is a named notice, and the key is erased anyway', async () => {
    const key = stubKey();
    const notice = await endSigningSession({
      meta: META,
      fallbackSubOrgId: null,
      openSessionKey: key.openSessionKey,
      revokeSessionKey: revokeFails,
    });
    expect(notice).toBe(demo.session.revokeFailed);
    expect(key.calls.cleared).toBe(1);
  });

  test('a failed ERASE says so in its own words — never the softer "key is erased" line', async () => {
    const key = stubKey({ clearThrows: true });
    const notice = await endSigningSession({
      meta: META,
      fallbackSubOrgId: null,
      openSessionKey: key.openSessionKey,
      revokeSessionKey: revoked,
    });
    expect(notice).toBe(demo.session.eraseFailed);
    expect(notice).not.toBe(demo.session.revokeFailed);
  });

  test('an unopenable key surface reports a failed erase rather than resolving silently', async () => {
    const key = stubKey({ openThrows: true });
    const notice = await endSigningSession({
      meta: META,
      fallbackSubOrgId: null,
      openSessionKey: key.openSessionKey,
      revokeSessionKey: revoked,
    });
    expect(notice).toBe(demo.session.eraseFailed);
  });
});

describe('signOutIntent — a re-authentication in flight is not a sign-out', () => {
  test('with no re-auth in flight, sign out means sign out', () => {
    expect(signOutIntent(false)).toBe('sign-out');
  });

  test('mid re-authentication the first click abandons the refresh, not the Original', () => {
    // The creator may already have BTC at a deposit address for the in-flight
    // Original. React batches signOut()'s setUser(null) with its
    // setReauth({active:false}), so the identity effect sees an anonymous
    // identity AND an inactive re-auth in one render — identityTransition
    // returns 'reset' and the asset is gone. Never start that from here.
    expect(signOutIntent(true)).toBe('cancel-reauth');
  });
});
