/**
 * The sign-out sequence, as a pure async function over injected capabilities.
 *
 * It lives outside useAuth.tsx because the two rules it enforces are the kind
 * that decay silently inside a hook: the browser's 12-hour signing credential
 * must be erased whatever else fails, and a re-authentication in flight must
 * never be turned into a sign-out.
 */
import type { RevocationOutcome, SigningSessionMeta, TurnkeyRevocationApi } from './turnkey-session';
import { demo } from '../content';

/** Just enough of SessionKeyHandle for sign-out: stamp with it, then destroy it. */
export interface ErasableSessionKey {
  client: unknown;
  clear(): Promise<void>;
}

export interface EndSigningSessionDeps {
  /** The session metadata, or null when storage/`user` could not be read. */
  meta: SigningSessionMeta | null;
  /** The signed-in sub-org, used when the metadata is the thing that's missing. */
  fallbackSubOrgId: string | null;
  openSessionKey: (subOrgId?: string) => Promise<ErasableSessionKey>;
  revokeSessionKey: (
    api: TurnkeyRevocationApi,
    meta: SigningSessionMeta
  ) => Promise<RevocationOutcome>;
}

/**
 * Revoke at Turnkey where possible, and ALWAYS erase locally.
 *
 * The erase is not gated on `meta`: storage denied, a `writeSessionMeta` quota
 * failure after OTP_LOGIN succeeded, or a failed `fetchMe` all leave the
 * metadata unreadable while a live non-extractable credential sits in
 * IndexedDB. A failed revoke is a visible UI state; a skipped erase is
 * invisible, which is exactly why it must not be skippable.
 *
 * Returns the notice to show, or null when everything worked.
 */
export async function endSigningSession(deps: EndSigningSessionDeps): Promise<string | null> {
  // The IndexedDB key is per-BROWSER; the sub-org only scopes the client's
  // requests. So '' is a usable last resort — there is still a key to destroy.
  const subOrgId = deps.meta?.subOrgId ?? deps.fallbackSubOrgId ?? '';
  let notice: string | null = null;
  let handle: ErasableSessionKey | null = null;
  try {
    handle = await deps.openSessionKey(subOrgId);
    // Revocation needs the public key the session was installed under; without
    // the metadata there is nothing to match, so it is skipped, not guessed.
    if (deps.meta) {
      const outcome = await deps.revokeSessionKey(
        handle.client as TurnkeyRevocationApi,
        deps.meta
      );
      if (outcome === 'revoke-failed') notice = demo.session.revokeFailed;
    }
  } catch {
    if (deps.meta) notice = demo.session.revokeFailed;
  } finally {
    try {
      await (handle ?? (await deps.openSessionKey(subOrgId))).clear();
    } catch {
      // Stronger than revokeFailed, which promises the local key is gone.
      notice = demo.session.eraseFailed;
    }
  }
  return notice;
}

/**
 * What a Sign out click should actually do (FR1).
 *
 * While a signing-session refresh is in flight the creator may already have BTC
 * sitting at a deposit address for the in-flight Original, and signing out
 * destroys it: React batches `setUser(null)` with `setReauth({active:false})`,
 * so the demo's identity effect sees an anonymous identity and an INACTIVE
 * re-auth in the same render and resets. The first click abandons the refresh
 * instead; a second one — now an ordinary signed-in state — signs out for real.
 */
export type SignOutIntent = 'sign-out' | 'cancel-reauth';

export function signOutIntent(reauthActive: boolean): SignOutIntent {
  return reauthActive ? 'cancel-reauth' : 'sign-out';
}
