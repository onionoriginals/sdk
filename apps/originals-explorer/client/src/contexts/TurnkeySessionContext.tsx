/**
 * Turnkey Session Context
 * Provides global access to Turnkey client session established during login
 * Prevents duplicate OTP flows by reusing the same session for signing operations
 */

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { TurnkeyClient } from '@turnkey/core';
import type { TurnkeyWallet } from '@/lib/turnkey-client';

interface TurnkeySessionState {
  client: TurnkeyClient | null;
  email: string | null;
  subOrgId: string | null;
  sessionToken: string | null;
  wallets: TurnkeyWallet[];
  isAuthenticated: boolean;
}

interface TurnkeySessionContextValue extends TurnkeySessionState {
  setSession: (session: Partial<TurnkeySessionState>) => void;
  clearSession: () => void;
}

const TurnkeySessionContext = createContext<TurnkeySessionContextValue | null>(null);

const SESSION_STORAGE_KEY = 'turnkey_session';

/**
 * Provider component that manages Turnkey session state
 */
export function TurnkeySessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<TurnkeySessionState>(() => {
    // Try to restore session from sessionStorage on mount
    if (typeof window !== 'undefined') {
      try {
        const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          // We can't serialize the TurnkeyClient instance, so we'll need to reinitialize it
          return {
            client: null, // Will be reinitialized
            email: parsed.email || null,
            subOrgId: parsed.subOrgId || null,
            sessionToken: parsed.sessionToken || null,
            wallets: parsed.wallets || [],
            isAuthenticated: !!parsed.sessionToken,
          };
        }
      } catch (error) {
        console.error('Failed to restore Turnkey session:', error);
      }
    }
    return {
      client: null,
      email: null,
      subOrgId: null,
      sessionToken: null,
      wallets: [],
      isAuthenticated: false,
    };
  });

  // Persist session to sessionStorage whenever it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (session.sessionToken) {
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
          email: session.email,
          subOrgId: session.subOrgId,
          sessionToken: session.sessionToken,
          wallets: session.wallets,
        }));
      } else {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
      }
    }
  }, [session.email, session.subOrgId, session.sessionToken, session.wallets]);

  const setSession = useCallback((newSession: Partial<TurnkeySessionState>) => {
    setSessionState(prev => ({
      ...prev,
      ...newSession,
      isAuthenticated: !!(newSession.sessionToken ?? prev.sessionToken),
    }));
  }, []);

  const clearSession = useCallback(() => {
    setSessionState({
      client: null,
      email: null,
      subOrgId: null,
      sessionToken: null,
      wallets: [],
      isAuthenticated: false,
    });
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, []);

  return (
    <TurnkeySessionContext.Provider value={{ ...session, setSession, clearSession }}>
      {children}
    </TurnkeySessionContext.Provider>
  );
}

/**
 * Hook to access Turnkey session
 * @throws {Error} if used outside TurnkeySessionProvider
 */
export function useTurnkeySession() {
  const context = useContext(TurnkeySessionContext);
  if (!context) {
    throw new Error('useTurnkeySession must be used within TurnkeySessionProvider');
  }
  return context;
}
