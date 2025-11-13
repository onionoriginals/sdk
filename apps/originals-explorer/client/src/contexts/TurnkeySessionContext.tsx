/**
 * Turnkey Session Context
 * Provides global access to Turnkey client session established during login
 * Prevents duplicate OTP flows by reusing the same session for signing operations
 */

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { TurnkeyClient } from '@turnkey/core';
import { initializeTurnkeyClient, fetchUser } from '@/lib/turnkey-client';
import type { TurnkeyWallet } from '@/lib/turnkey-client';
import { apiRequest } from '@/lib/queryClient';

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
  refreshSession: () => Promise<boolean>;
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
            // isAuthenticated only requires sessionToken - wallets may be empty for new users
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
      // isAuthenticated only requires sessionToken - wallets may be empty for new users
      isAuthenticated: !!(newSession.sessionToken ?? prev.sessionToken),
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

  /**
   * Refresh the Turnkey session silently
   * Extends the session expiration time without requiring user interaction
   * Also updates the server-side JWT cookie to keep it in sync
   * @returns true if refresh was successful, false otherwise
   */
  const refreshSession = useCallback(async (): Promise<boolean> => {
    if (!session.client || !session.sessionToken || !session.email) {
      console.warn('Cannot refresh session: missing client, session token, or email');
      return false;
    }

    try {
      // Refresh the session - this extends expiration time
      // Using 1 hour expiration (3600 seconds)
      const refreshResult = await session.client.refreshSession({
        expirationSeconds: '3600',
      });

      if (!refreshResult?.session) {
        console.warn('Refresh session returned no session token');
        return false;
      }

      // Fetch user info to get userId for server-side JWT update
      let userId: string;
      try {
        const userInfo = await fetchUser(session.client);
        userId = userInfo.userId;
      } catch (error) {
        console.error('Failed to fetch user info during refresh:', error);
        // Still update the client-side session token even if we can't update server JWT
        setSessionState(prev => ({
          ...prev,
          sessionToken: refreshResult.session,
        }));
        return false; // Partial success, but server JWT not updated
      }

      // Update server-side JWT cookie to keep it in sync with refreshed session
      try {
        await apiRequest('POST', '/api/auth/exchange-session', {
          email: session.email,
          userId,
          sessionToken: refreshResult.session,
        });
      } catch (error) {
        console.error('Failed to update server-side JWT during refresh:', error);
        // Still update the client-side session token
        setSessionState(prev => ({
          ...prev,
          sessionToken: refreshResult.session,
        }));
        return false; // Partial success, but server JWT not updated
      }

      // Update session with new token (both client and server are now updated)
      setSessionState(prev => ({
        ...prev,
        sessionToken: refreshResult.session,
      }));
      
      console.log('Session refreshed successfully (client and server updated)');
      return true;
    } catch (error) {
      console.error('Failed to refresh session:', error);
      // If refresh fails, it might be because the session is already expired
      // or there's a network issue - return false to allow fallback handling
      return false;
    }
  }, [session.client, session.sessionToken, session.email]);

  // Automatically refresh session before it expires
  // Refresh every 10 minutes to prevent expiration (sessions typically expire in 15-30 minutes)
  // After refresh, sessions are extended to 1 hour, so subsequent refreshes happen every 10 minutes
  useEffect(() => {
    if (!session.isAuthenticated || !session.client || !session.sessionToken) {
      return;
    }

    // Refresh session every 10 minutes to prevent expiration
    const refreshInterval = setInterval(async () => {
      try {
        console.log('Performing background session refresh...');
        const refreshed = await refreshSession();
        if (!refreshed) {
          console.warn('Background session refresh failed');
        }
      } catch (error) {
        console.error('Error during background session refresh:', error);
      }
    }, 10 * 60 * 1000); // 10 minutes

    return () => clearInterval(refreshInterval);
  }, [session.isAuthenticated, session.client, session.sessionToken, refreshSession]);

  const handleTokenExpired = useCallback(async () => {
    // Try to refresh first before redirecting
    if (session.client && session.sessionToken) {
      console.log('Session expired detected, attempting to refresh...');
      const refreshed = await refreshSession();
      if (refreshed) {
        console.log('Session refreshed successfully, continuing...');
        return; // Successfully refreshed, no need to redirect
      }
    }

    // If refresh failed, proceed with redirect
    console.warn('Turnkey session expired and refresh failed, redirecting to login');

    // Clear the expired session
    clearSession();

    // Store current path for return after re-authentication
    if (typeof window !== 'undefined') {
      const currentPath = window.location.pathname + window.location.search;
      sessionStorage.setItem('loginReturnTo', currentPath);

      // Use setTimeout to ensure redirect happens even if there are pending operations
      setTimeout(() => {
        // Redirect to login page
        window.location.href = `/login?returnTo=${encodeURIComponent(currentPath)}&reason=session_expired`;
      }, 100);
    }
  }, [session.client, session.sessionToken, refreshSession, clearSession]);

  return (
    <TurnkeySessionContext.Provider value={{ ...session, setSession, clearSession, handleTokenExpired, refreshSession }}>
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
