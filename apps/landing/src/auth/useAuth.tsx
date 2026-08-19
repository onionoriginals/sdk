import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import * as api from './api';
import type { AuthUser } from './api';
import { createUserWebVHDid } from './webvh';
import {
  otpLoginToSession,
  ensureBitcoinFundingAccount,
  readSessionMeta,
  writeSessionMeta,
  clearSessionMeta,
  revokeSessionKey,
  signingStatus,
  restoreDecision,
  type SigningStatus,
  type TurnkeyBitcoinClient,
  type TurnkeySessionApi,
} from './turnkey-session';
import type { SessionKeyHandle } from './turnkey-browser-client';
import { btcNetwork } from '../sdk/network-flag';
import { demo } from '../content';

export interface BitcoinSession {
  fundingAddress: string;
  signingClient: TurnkeyBitcoinClient;
}

/**
 * Re-authentication is a SIGNING-session refresh, not a sign-out: the 7-day
 * auth cookie and `user` are untouched, so the demo's identity-keyed reset
 * never fires and the in-flight Original survives. `fromSubOrgId` is carried so
 * a consumer can tell "the same user came back" from "a different account".
 */
export interface ReauthState {
  active: boolean;
  fromSubOrgId: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionId: string | null;
  /** The user's signing client + funding address (null until ready / when disabled). */
  bitcoin: BitcoinSession | null;
  /** Whether this browser can sign right now. Checked BEFORE funds are asked for. */
  signing: SigningStatus;
  reauth: ReauthState;
  /** Set when sign-out erased the key locally but could not revoke it at Turnkey. */
  signOutNotice: string | null;
  startOtp: (email: string) => Promise<void>;
  verify: (code: string) => Promise<void>;
  createIdentity: () => Promise<string>;
  signOut: () => Promise<void>;
  /** Start a signing-session refresh: re-sends the OTP without signing out. */
  beginReauth: () => Promise<void>;
  cancelReauth: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** localStorage, or a no-op when the browser denies it (private mode, etc.). */
function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [bitcoin, setBitcoin] = useState<BitcoinSession | null>(null);
  const [signing, setSigning] = useState<SigningStatus>('none');
  const [reauth, setReauth] = useState<ReauthState>({ active: false, fromSubOrgId: null });
  const [signOutNotice, setSignOutNotice] = useState<string | null>(null);

  /**
   * Rebuild the signing capability from what survived the reload: the session's
   * metadata in localStorage plus the non-extractable key in IndexedDB. Without
   * this a reload leaves `isAuthenticated && !bitcoin` — signed in, unable to
   * sign, with no way back because the verification token is single-use.
   */
  const restoreSigning = useCallback(async (restored: AuthUser) => {
    const storage = browserStorage();
    const meta = storage ? readSessionMeta(storage, restored.subOrgId) : null;
    const network = btcNetwork();
    if (!meta || network === 'off') {
      setSigning(signingStatus(meta));
      return;
    }
    try {
      const { openSessionKey } = await import('./turnkey-browser-client');
      const handle = await openSessionKey(restored.subOrgId);
      const decision = restoreDecision(meta, handle.signer.publicKeyHex);
      if (decision !== 'restore') {
        setSigning(decision === 'expired' ? 'expired' : 'none');
        return;
      }
      const signingClient = handle.client as unknown as TurnkeyBitcoinClient;
      const fundingAddress = await ensureBitcoinFundingAccount(signingClient, restored.subOrgId, network);
      setBitcoin({ fundingAddress, signingClient });
      setSigning('active');
    } catch (err) {
      console.warn('[originals-demo] could not restore the signing session', err);
      setBitcoin(null);
      setSigning('none');
    }
  }, []);

  useEffect(() => {
    api
      .fetchMe()
      .then(async (restored) => {
        setUser(restored);
        if (restored) await restoreSigning(restored);
      })
      .finally(() => setIsLoading(false));
  }, [restoreSigning]);

  // Re-report expiry as it happens, so a session that dies while the deposit
  // screen is open flips the UI instead of waiting for a click to fail.
  useEffect(() => {
    if (signing !== 'active') return;
    const storage = browserStorage();
    const subOrgId = user?.subOrgId;
    if (!storage || !subOrgId) return;
    const t = setInterval(() => {
      if (signingStatus(readSessionMeta(storage, subOrgId)) !== 'active') {
        setSigning('expired');
        setBitcoin(null);
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [signing, user?.subOrgId]);

  const startOtp = useCallback(async (email: string) => {
    const { sessionId } = await api.startOtp(email);
    setSessionId(sessionId);
  }, []);

  const verify = useCallback(async (code: string) => {
    if (!sessionId) throw new Error('Start the OTP flow first');
    // Mint a FRESH non-extractable session key first: verify-otp binds the
    // verification token to its public half, so it has to exist by then. The
    // private half is a CryptoKey in IndexedDB with no readable scalar.
    let sessionKey: SessionKeyHandle | null = null;
    const network = btcNetwork();
    if (network !== 'off') {
      try {
        const { resetSessionKey } = await import('./turnkey-browser-client');
        sessionKey = await resetSessionKey();
      } catch (err) {
        console.warn('[originals-demo] could not open a browser signing key', err);
      }
    }
    const result = await api.completeOtp(sessionId, code, sessionKey?.signer.publicKeyHex);
    setUser({ subOrgId: result.subOrgId, email: result.email });
    setSessionId(null);
    setSignOutNotice(null);

    // Track B bootstrap: install the session key on the sub-org (OTP_LOGIN),
    // then build the signing client + ensure the network's funding account.
    // Best-effort: a failure here must NOT block login — the demo falls back to
    // the mock inscribe path. Only runs when the deploy enabled a real network.
    if (network === 'off' || !result.verificationToken || !sessionKey) {
      setReauth({ active: false, fromSubOrgId: null });
      return;
    }
    try {
      // Re-open against the real sub-org: same IndexedDB key, but
      // signTransaction carries no organizationId of its own, so the client's
      // configured org is what a Bitcoin signature is scoped to.
      const { openSessionKey } = await import('./turnkey-browser-client');
      const bound = await openSessionKey(result.subOrgId);
      const signingClient = bound.client as unknown as TurnkeyBitcoinClient;
      const { meta } = await otpLoginToSession({
        turnkey: signingClient as unknown as TurnkeySessionApi,
        subOrgId: result.subOrgId,
        verificationToken: result.verificationToken,
        signer: bound.signer,
      });
      const storage = browserStorage();
      if (storage) writeSessionMeta(storage, meta);
      const fundingAddress = await ensureBitcoinFundingAccount(signingClient, result.subOrgId, network);
      setBitcoin({ fundingAddress, signingClient });
      setSigning('active');
    } catch (err) {
      // Non-fatal: log for the console-visible demo narrative; UI stays on mock.
      console.warn('[originals-demo] bitcoin session bootstrap failed; inscribe stays on mock', err);
      setBitcoin(null);
      setSigning('none');
    } finally {
      setReauth({ active: false, fromSubOrgId: null });
    }
  }, [sessionId]);

  const beginReauth = useCallback(async () => {
    if (!user) throw new Error('Sign in before refreshing a signing session');
    setReauth({ active: true, fromSubOrgId: user.subOrgId });
    await startOtp(user.email);
  }, [user, startOtp]);

  const cancelReauth = useCallback(() => {
    setReauth({ active: false, fromSubOrgId: null });
    setSessionId(null);
  }, []);

  const createIdentity = useCallback(async () => {
    if (!user) throw new Error('Sign in before creating an identity');
    // Signed in the browser with a real Ed25519 key (see auth/webvh.ts): the
    // parent Turnkey key can't sign for the credential-less sub-org.
    const { did } = await createUserWebVHDid({ subOrgId: user.subOrgId, email: user.email });
    return did;
  }, [user]);

  const signOut = useCallback(async () => {
    const storage = browserStorage();
    const meta = storage && user ? readSessionMeta(storage, user.subOrgId) : null;
    let notice: string | null = null;
    if (meta) {
      const { openSessionKey, asRevocationApi } = await import('./turnkey-browser-client');
      let handle: SessionKeyHandle | null = null;
      try {
        handle = await openSessionKey(meta.subOrgId);
        if ((await revokeSessionKey(asRevocationApi(handle.client), meta)) === 'revoke-failed') {
          notice = demo.session.revokeFailed;
        }
      } catch {
        notice = demo.session.revokeFailed;
      } finally {
        // A failed revocation still erases locally — never leave a live mainnet
        // signing key behind on a shared browser while the UI says signed out.
        try {
          await (handle ?? (await openSessionKey(meta.subOrgId))).clear();
        } catch {
          notice = demo.session.revokeFailed;
        }
      }
    }
    if (storage) clearSessionMeta(storage);
    await api.logout();
    setUser(null);
    setBitcoin(null);
    setSigning('none');
    setReauth({ active: false, fromSubOrgId: null });
    setSignOutNotice(notice);
  }, [user]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        sessionId,
        bitcoin,
        signing,
        reauth,
        signOutNotice,
        startOtp,
        verify,
        createIdentity,
        signOut,
        beginReauth,
        cancelReauth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
