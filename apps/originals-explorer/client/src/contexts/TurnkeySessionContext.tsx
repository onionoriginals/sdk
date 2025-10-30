/**
 * Turnkey Session Context
 * Provides global access to Turnkey client session established during login
 * Prevents duplicate OTP flows by reusing the same session for signing operations
 */

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { TurnkeyClient } from '@turnkey/core';
import { initializeTurnkeyClient } from '@/lib/turnkey-client';
import type { TurnkeyWallet } from '@/lib/turnkey-client';

interface TurnkeySessionState {
  client: TurnkeyClient | null;
  email: string | null;
  sessionToken: string | null;
  wallets: TurnkeyWallet[];
  isAuthenticated: boolean;
}

interface TurnkeySessionContextValue extends TurnkeySessionState {
  setSession: (session: Partial<TurnkeySessionState>) => void;
  clearSession: () => void;
  handleTokenExpired: () => void;
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
          // Reinitialize the TurnkeyClient with stored session
          let client: TurnkeyClient | null = null;
          if (parsed.sessionToken) {
            client = initializeTurnkeyClient();
            // The client will use the session token automatically after init
            client.init().catch(err => console.error('Failed to init Turnkey client:', err));
          }

          return {
            client,
            email: parsed.email || null,
            sessionToken: parsed.sessionToken || null,
            wallets: parsed.wallets || [],
            isAuthenticated: !!parsed.sessionToken && !!(parsed.wallets?.length),
          };
        }
      } catch (error) {
        console.error('Failed to restore Turnkey session:', error);
      }
    }
    return {
      client: null,
      email: null,
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
          sessionToken: session.sessionToken,
          wallets: session.wallets,
        }));
      } else {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
      }
    }
  }, [session.email, session.sessionToken, session.wallets]);

  const setSession = useCallback((newSession: Partial<TurnkeySessionState>) => {
    setSessionState(prev => ({
      ...prev,
      ...newSession,
      isAuthenticated: !!(newSession.sessionToken ?? prev.sessionToken) &&
                      !!((newSession.wallets ?? prev.wallets)?.length),
    }));
  }, []);

  const clearSession = useCallback(() => {
    setSessionState({
      client: null,
      email: null,
      sessionToken: null,
      wallets: [],
      isAuthenticated: false,
    });
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, []);

  const handleTokenExpired = useCallback(() => {
    console.warn('Turnkey session expired, clearing session and redirecting to login');

    // Clear the expired session
    clearSession();

    // Store current path for return after re-authentication
    if (typeof window !== 'undefined') {
      const currentPath = window.location.pathname + window.location.search;
      sessionStorage.setItem('loginReturnTo', currentPath);

      // Redirect to login page
      window.location.href = `/login?returnTo=${encodeURIComponent(currentPath)}&reason=session_expired`;
    }
  }, [clearSession]);

  return (
    <TurnkeySessionContext.Provider value={{ ...session, setSession, clearSession, handleTokenExpired }}>
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
