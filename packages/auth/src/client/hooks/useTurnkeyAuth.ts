/**
 * Turnkey Authentication Hook
 * Manages Turnkey authentication state and OTP flow
 */

import { useState, useCallback } from 'react';
import { TurnkeyClient, WalletAccount } from '@turnkey/core';
import {
  initializeTurnkeyClient,
  initOtp,
  completeOtp,
  fetchWallets,
  getKeyByCurve,
} from '../turnkey-client';
import type { TurnkeyWallet, TurnkeyAuthState } from '../../types';

interface UseTurnkeyAuthOptions {
  /** Callback when session expires */
  onSessionExpired?: () => void;
  /** API base URL for exchanging session token */
  apiBaseUrl?: string;
}

interface UseTurnkeyAuthReturn {
  // State
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  turnkeyClient: TurnkeyClient | null;
  email: string | null;
  wallets: TurnkeyWallet[];

  // Methods
  requestOtp: (email: string) => Promise<{ success: boolean; otpId?: string; error?: string }>;
  verifyAndLogin: (otpCode: string) => Promise<{
    success: boolean;
    sessionToken?: string;
    userId?: string;
    wallets?: TurnkeyWallet[];
    action?: 'login' | 'signup';
    error?: string;
  }>;
  logout: () => void;
  getKeyByCurveType: (curve: 'CURVE_SECP256K1' | 'CURVE_ED25519') => WalletAccount | null;
  getAuthKey: () => WalletAccount | null;
  getAssertionKey: () => WalletAccount | null;
  getUpdateKey: () => WalletAccount | null;
}

/**
 * Hook for managing Turnkey authentication flow
 *
 * @example
 * ```tsx
 * function LoginForm() {
 *   const [email, setEmail] = useState('');
 *   const [code, setCode] = useState('');
 *   const [step, setStep] = useState<'email' | 'code'>('email');
 *
 *   const { requestOtp, verifyAndLogin, isLoading, error } = useTurnkeyAuth();
 *
 *   const handleRequestOtp = async () => {
 *     const result = await requestOtp(email);
 *     if (result.success) {
 *       setStep('code');
 *     }
 *   };
 *
 *   const handleVerify = async () => {
 *     const result = await verifyAndLogin(code);
 *     if (result.success) {
 *       // User is now authenticated
 *     }
 *   };
 *
 *   if (step === 'email') {
 *     return (
 *       <form onSubmit={handleRequestOtp}>
 *         <input value={email} onChange={(e) => setEmail(e.target.value)} />
 *         <button type="submit" disabled={isLoading}>Send Code</button>
 *       </form>
 *     );
 *   }
 *
 *   return (
 *     <form onSubmit={handleVerify}>
 *       <input value={code} onChange={(e) => setCode(e.target.value)} />
 *       <button type="submit" disabled={isLoading}>Verify</button>
 *     </form>
 *   );
 * }
 * ```
 */
export function useTurnkeyAuth(options: UseTurnkeyAuthOptions = {}): UseTurnkeyAuthReturn {
  const { onSessionExpired, apiBaseUrl = '' } = options;

  const [state, setState] = useState<
    TurnkeyAuthState & {
      turnkeyClient: TurnkeyClient | null;
    }
  >({
    isAuthenticated: false,
    isLoading: false,
    error: null,
    email: null,
    wallets: [],
    otpId: null,
    turnkeyClient: null,
  });

  /**
   * Step 1: Request OTP to be sent to email
   */
  const requestOtp = useCallback(async (email: string) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const client = initializeTurnkeyClient();
      await client.init();
      const otpId = await initOtp(client, email);

      setState((prev) => ({
        ...prev,
        isLoading: false,
        turnkeyClient: client,
        email,
        otpId,
      }));

      return { success: true, otpId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to send OTP';
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
      }));
      return { success: false, error: errorMessage };
    }
  }, []);

  /**
   * Step 2: Verify OTP and complete authentication
   */
  const verifyAndLogin = useCallback(async (otpCode: string) => {
    if (!state.turnkeyClient || !state.otpId || !state.email) {
      const errorMessage = 'Must request OTP first';
      setState((prev) => ({ ...prev, error: errorMessage }));
      return { success: false, error: errorMessage };
    }

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const { sessionToken, userId, action } = await completeOtp(
        state.turnkeyClient,
        state.otpId,
        otpCode,
        state.email
      );

      const wallets = await fetchWallets(state.turnkeyClient, onSessionExpired);

      // Exchange session token for JWT cookie
      const exchangeResponse = await fetch(`${apiBaseUrl}/api/auth/exchange-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: state.email,
          userId,
          sessionToken,
        }),
      });

      if (!exchangeResponse.ok) {
        throw new Error('Failed to exchange session token');
      }

      setState((prev) => ({
        ...prev,
        isLoading: false,
        isAuthenticated: true,
        wallets,
      }));

      return { success: true, sessionToken, userId, wallets, action };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to verify OTP';
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
      }));
      return { success: false, error: errorMessage };
    }
  }, [state.turnkeyClient, state.otpId, state.email, onSessionExpired, apiBaseUrl]);

  /**
   * Logout and clear state
   */
  const logout = useCallback(() => {
    setState({
      isAuthenticated: false,
      isLoading: false,
      error: null,
      turnkeyClient: null,
      email: null,
      wallets: [],
      otpId: null,
    });
  }, []);

  /**
   * Get key by curve type
   */
  const getKeyByCurveType = useCallback(
    (curve: 'CURVE_SECP256K1' | 'CURVE_ED25519'): WalletAccount | null => {
      return getKeyByCurve(state.wallets, curve);
    },
    [state.wallets]
  );

  /**
   * Get authentication key (SECP256K1)
   */
  const getAuthKey = useCallback((): WalletAccount | null => {
    return getKeyByCurveType('CURVE_SECP256K1');
  }, [getKeyByCurveType]);

  /**
   * Get assertion key (ED25519)
   */
  const getAssertionKey = useCallback((): WalletAccount | null => {
    return getKeyByCurveType('CURVE_ED25519');
  }, [getKeyByCurveType]);

  /**
   * Get update key (second ED25519)
   */
  const getUpdateKey = useCallback((): WalletAccount | null => {
    const ed25519Keys = state.wallets.flatMap((wallet) =>
      wallet.accounts.filter((account) => account.curve === 'CURVE_ED25519')
    );
    return ed25519Keys.length > 1 ? (ed25519Keys[1] as unknown as WalletAccount) : null;
  }, [state.wallets]);

  return {
    isAuthenticated: state.isAuthenticated,
    isLoading: state.isLoading,
    error: state.error,
    turnkeyClient: state.turnkeyClient,
    email: state.email,
    wallets: state.wallets,
    requestOtp,
    verifyAndLogin,
    logout,
    getKeyByCurveType,
    getAuthKey,
    getAssertionKey,
    getUpdateKey,
  };
}



