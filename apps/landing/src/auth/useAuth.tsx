import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import * as api from './api';
import type { AuthUser } from './api';

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionId: string | null;
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
  }, [sessionId]);

  const createIdentity = useCallback(async () => {
    const { did } = await api.createDid();
    return did;
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, isAuthenticated: !!user, isLoading, sessionId, startOtp, verify, createIdentity, signOut }}
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
