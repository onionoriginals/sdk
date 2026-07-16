import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import * as api from './api';
import type { AuthUser } from './api';
import { createUserWebVHDid } from './webvh';
import {
  otpLoginToSession,
  ensureBitcoinFundingAccount,
  type TurnkeyBitcoinClient,
  type TurnkeySessionApi,
} from './turnkey-session';

// Track B activates only when the deploy enables testnet4 signing.
const btcTestnetEnabled =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_BTC_TESTNET === '1';

export interface BitcoinSession {
  fundingAddress: string;
  signingClient: TurnkeyBitcoinClient;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionId: string | null;
  /** Track B: the user's testnet4 signing client + funding address (null until ready / when disabled). */
  bitcoin: BitcoinSession | null;
  startOtp: (email: string) => Promise<void>;
  verify: (code: string) => Promise<void>;
  createIdentity: () => Promise<string>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [bitcoin, setBitcoin] = useState<BitcoinSession | null>(null);

  useEffect(() => {
    api.fetchMe().then(setUser).finally(() => setIsLoading(false));
  }, []);

  const startOtp = useCallback(async (email: string) => {
    const { sessionId } = await api.startOtp(email);
    setSessionId(sessionId);
  }, []);

  const verify = useCallback(async (code: string) => {
    if (!sessionId) throw new Error('Start the OTP flow first');
    const result = await api.completeOtp(sessionId, code);
    setUser({ subOrgId: result.subOrgId, email: result.email });
    setSessionId(null);

    // Track B bootstrap: install the P-256 session credential (OTP_LOGIN), then
    // build the signing client + ensure the testnet4 funding account. Best-
    // effort: a failure here must NOT block login — the demo simply falls back
    // to the mock inscribe path. Only runs when the deploy enabled testnet4.
    if (!btcTestnetEnabled || !result.verificationToken) return;
    try {
      // Lazy-load the browser Turnkey client so its browser-only dependency
      // graph never loads unless Track B is actually active.
      const { buildBrowserSigningClient } = await import('./turnkey-browser-client');
      const signingClient = buildBrowserSigningClient({
        subOrgId: result.subOrgId,
        p256PublicKey: result.p256PublicKey,
        p256PrivateKey: result.p256PrivateKey,
      });
      await otpLoginToSession({
        turnkey: signingClient as unknown as TurnkeySessionApi,
        subOrgId: result.subOrgId,
        verificationToken: result.verificationToken,
        p256PublicKey: result.p256PublicKey,
        p256PrivateKey: result.p256PrivateKey,
      });
      const fundingAddress = await ensureBitcoinFundingAccount(signingClient, result.subOrgId);
      setBitcoin({ fundingAddress, signingClient });
    } catch (err) {
      // Non-fatal: log for the console-visible demo narrative; UI stays on mock.
      console.warn('[originals-demo] testnet4 session bootstrap failed; inscribe stays on mock', err);
      setBitcoin(null);
    }
  }, [sessionId]);

  const createIdentity = useCallback(async () => {
    if (!user) throw new Error('Sign in before creating an identity');
    // Signed in the browser with a real Ed25519 key (see auth/webvh.ts): the
    // parent Turnkey key can't sign for the credential-less sub-org.
    const { did } = await createUserWebVHDid({ subOrgId: user.subOrgId, email: user.email });
    return did;
  }, [user]);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
    setBitcoin(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, isAuthenticated: !!user, isLoading, sessionId, bitcoin, startOtp, verify, createIdentity, signOut }}
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
