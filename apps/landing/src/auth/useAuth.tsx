import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import * as api from './api';
import type { AuthUser } from './api';
import { createUserWebVHDid, readUserWebVHDid } from './webvh';
import {
  stampLoginToSession,
  ensureBitcoinFundingAccount,
  ensureIdentityAccount,
  ensureAuthorshipAccount,
  readSessionMeta,
  writeSessionMeta,
  clearSessionMeta,
  revokeSessionKey,
  signingStatus,
  restoreDecision,
  type SigningStatus,
  type TurnkeyBitcoinClient,
} from './turnkey-session';
import type { SessionKeyHandle } from './turnkey-browser-client';
import { browserKeyStorage } from './browser-storage';
import { DurableHostingStorageAdapter } from '../sdk/durable-hosting-adapter';
import { endSigningSession, signOutIntent } from './sign-out';
import { btcNetwork } from '../sdk/network-flag';
import {
  reportBootstrapFailure,
  prerequisiteFailure,
  signingFailureNotice,
  type BootstrapStep,
} from './bootstrap-report';

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
  /** Set when sign-out could not revoke the key at Turnkey — or could not erase it here. */
  signOutNotice: string | null;
  /**
   * Why `signing` is 'unavailable', when the user should know. Null means the
   * generic copy is right; set when this browser refused a sign-in token bound
   * to a key it does not hold (#494). Same shape as signOutNotice.
   */
  signingNotice: string | null;
  startOtp: (email: string) => Promise<void>;
  verify: (code: string) => Promise<void>;
  createIdentity: () => Promise<string>;
  /** The already-published DID, or null. Never mints — see `loadIdentity`. */
  loadIdentity: () => Promise<string | null>;
  signOut: () => Promise<void>;
  /** Start a signing-session refresh: re-sends the OTP without signing out. */
  beginReauth: () => Promise<void>;
  cancelReauth: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [bitcoin, setBitcoin] = useState<BitcoinSession | null>(null);
  const [signing, setSigning] = useState<SigningStatus>('none');
  const [reauth, setReauth] = useState<ReauthState>({ active: false, fromSubOrgId: null });
  const [signOutNotice, setSignOutNotice] = useState<string | null>(null);
  const [signingNotice, setSigningNotice] = useState<string | null>(null);

  /**
   * Rebuild the signing capability from what survived the reload: the session's
   * metadata in localStorage plus the non-extractable key in IndexedDB. Without
   * this a reload leaves `isAuthenticated && !bitcoin` — signed in, unable to
   * sign, with no way back because the verification token is single-use.
   */
  const restoreSigning = useCallback(async (restored: AuthUser) => {
    const storage = browserKeyStorage();
    const meta = storage ? readSessionMeta(storage, restored.subOrgId) : null;
    const network = btcNetwork();
    if (!meta || network === 'off') {
      setSigning(signingStatus(meta));
      return;
    }
    let step: BootstrapStep = 'open-session-key';
    try {
      const { openSessionKey } = await import('./turnkey-browser-client');
      const handle = await openSessionKey(restored.subOrgId);
      const decision = restoreDecision(meta, handle.signer.publicKeyHex);
      if (decision !== 'restore') {
        setSigning(decision === 'expired' ? 'expired' : 'none');
        return;
      }
      const signingClient = handle.client as unknown as TurnkeyBitcoinClient;
      step = 'funding-account';
      const fundingAddress = await ensureBitcoinFundingAccount(signingClient, restored.subOrgId, network);
      setBitcoin({ fundingAddress, signingClient });
      setSigning('active');
    } catch (err) {
      reportBootstrapFailure('reload', step, err);
      setBitcoin(null);
      setSigning('unavailable');
      setSigningNotice(signingFailureNotice(err));
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
    const storage = browserKeyStorage();
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
    setSigningNotice(null);

    // Track B bootstrap: install the session key on the sub-org (OTP_LOGIN),
    // then build the signing client + ensure the network's funding account.
    // Only runs when the deploy enabled a real network; on an 'off' build there
    // is nothing to bootstrap and the demo runs the mock inscribe path.
    if (network === 'off') {
      setReauth({ active: false, fromSubOrgId: null });
      return;
    }
    // On a real-network build these two are FAILURES, not "no key yet". They
    // used to return here silently, leaving signing at 'none' — which renders
    // the "sign in again to get one" copy for a browser that just did, and
    // reports nothing at all. Same defect as the gate, one layer earlier.
    if (!sessionKey || !result.verificationToken) {
      const failure = prerequisiteFailure({
        sessionKey: Boolean(sessionKey),
        verificationToken: Boolean(result.verificationToken),
      });
      if (failure) reportBootstrapFailure('sign-in', failure.step, new Error(failure.reason));
      setBitcoin(null);
      setSigning('unavailable');
      setReauth({ active: false, fromSubOrgId: null });
      return;
    }
    // Three different subsystems fail into the one catch below — the browser
    // key, Turnkey's OTP_LOGIN, and the Bitcoin funding account. Without this
    // label the report names none of them, and the whole surface reads as one
    // opaque "signing is unavailable".
    let step: BootstrapStep = 'open-session-key';
    try {
      // Re-open against the real sub-org: same IndexedDB key, but
      // signTransaction carries no organizationId of its own, so the client's
      // configured org is what a Bitcoin signature is scoped to.
      const { openSessionKey } = await import('./turnkey-browser-client');
      const bound = await openSessionKey(result.subOrgId);
      const signingClient = bound.client as unknown as TurnkeyBitcoinClient;
      step = 'otp-login';
      const { meta } = await stampLoginToSession({
        subOrgId: result.subOrgId,
        verificationToken: result.verificationToken,
        signer: bound.signer,
      });
      const storage = browserKeyStorage();
      if (storage) writeSessionMeta(storage, meta);
      step = 'funding-account';
      const fundingAddress = await ensureBitcoinFundingAccount(signingClient, result.subOrgId, network);
      setBitcoin({ fundingAddress, signingClient });
      setSigning('active');
    } catch (err) {
      // Non-fatal for sign-in itself, but on a real-network build the demo does
      // NOT fall back to mock — the inscribe step is gated. Mark it unavailable
      // so the UI says so instead of telling the user to sign in again.
      reportBootstrapFailure('sign-in', step, err);
      setBitcoin(null);
      setSigning('unavailable');
      setSigningNotice(signingFailureNotice(err));
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
    // Turnkey custody, so this needs a LIVE session: the sub-org quorum holds
    // only the user, so only their session credential can sign the DID. Refuse
    // by name rather than letting turnkeySignBytes fail deep in the build.
    if (!bitcoin?.signingClient) {
      throw new Error('Your signing session is not active — sign in again to create your DID.');
    }
    const client = bitcoin.signingClient;
    const [identityAddress, authorshipAddress] = await Promise.all([
      ensureIdentityAccount(client, user.subOrgId),
      // Attribution only (published as assertionMethod); never signs the DID.
      ensureAuthorshipAccount(client, user.subOrgId),
    ]);
    const { did } = await createUserWebVHDid({
      subOrgId: user.subOrgId,
      email: user.email,
      client,
      identityAddress,
      authorshipAddress,
      // DURABLE, not the /api/host demo store: that one is in-memory with a
      // 2h TTL and LRU eviction, and this log cannot be regenerated (a rebuild
      // gets a new SCID). Losing it loses the identity.
      hosting: new DurableHostingStorageAdapter(),
    });
    return did;
  }, [user, bitcoin]);

  /**
   * The DID this user already published, or null. Read-only: showing an
   * identity must never mint one, and unlike creating it needs no session.
   */
  const loadIdentity = useCallback(async () => {
    if (!user) return null;
    const found = await readUserWebVHDid({
      subOrgId: user.subOrgId,
      hosting: new DurableHostingStorageAdapter(),
    });
    return found?.did ?? null;
  }, [user]);

  const signOut = useCallback(async () => {
    // A refresh in flight is not a sign-out: abandon the refresh and stop.
    // The creator may have BTC at a deposit address for the in-flight Original,
    // and signing out here would reset the demo out from under it (FR1).
    if (signOutIntent(reauth.active) === 'cancel-reauth') {
      cancelReauth();
      return;
    }
    const storage = browserKeyStorage();
    const meta = storage && user ? readSessionMeta(storage, user.subOrgId) : null;
    // Unconditional erase, whatever we could read — see endSigningSession.
    // The chunk import goes INSIDE the injected opener so a failure to load it
    // lands in that function's own catch (a named notice) instead of throwing
    // out of signOut and leaving the user signed in.
    const notice = await endSigningSession({
      meta,
      fallbackSubOrgId: user?.subOrgId ?? null,
      openSessionKey: async (subOrgId) =>
        (await import('./turnkey-browser-client')).openSessionKey(subOrgId),
      revokeSessionKey,
    });
    if (storage) clearSessionMeta(storage);
    await api.logout();
    setUser(null);
    setBitcoin(null);
    setSigning('none');
    setSigningNotice(null);
    setReauth({ active: false, fromSubOrgId: null });
    setSignOutNotice(notice);
  }, [user, reauth.active, cancelReauth]);

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
        signingNotice,
        startOtp,
        verify,
        createIdentity,
        loadIdentity,
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
