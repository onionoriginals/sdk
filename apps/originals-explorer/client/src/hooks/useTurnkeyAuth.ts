/**
 * Turnkey Authentication Hook
 * Manages Turnkey authentication state and operations
 */

import { useState, useCallback } from 'react';
import { TurnkeyClient } from '@turnkey/core';
import {
  initializeTurnkeyClient,
  initOtp,
  verifyOtp,
  loginWithOtp,
  fetchWallets,
  getKeyByCurve,
  type TurnkeyWallet,
  type TurnkeyWalletAccount,
} from '@/lib/turnkey-client';

interface TurnkeyAuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  turnkeyClient: TurnkeyClient | null;
  email: string | null;
  subOrgId: string | null;
  sessionToken: string | null;
  wallets: TurnkeyWallet[];
  otpId: string | null;
  verificationToken: string | null;
}

export function useTurnkeyAuth() {
  const [state, setState] = useState<TurnkeyAuthState>({
    isAuthenticated: false,
    isLoading: false,
    error: null,
    turnkeyClient: null,
    email: null,
    subOrgId: null,
    sessionToken: null,
    wallets: [],
    otpId: null,
    verificationToken: null,
  });

  /**
   * Step 1: Request OTP to be sent to email
   */
  const requestOtp = useCallback(async (email: string) => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const client = initializeTurnkeyClient();
      await client.init();
      const otpId = await initOtp(client, email);

      setState(prev => ({
        ...prev,
        isLoading: false,
        turnkeyClient: client,
        email,
        otpId,
      }));

      return { success: true, otpId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to send OTP';
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
      }));
      return { success: false, error: errorMessage };
    }
  }, []);

  /**
   * Step 2: Verify OTP code and complete login
   */
  const verifyAndLogin = useCallback(async (otpCode: string) => {
    if (!state.turnkeyClient || !state.otpId || !state.email) {
      const errorMessage = 'Must request OTP first';
      setState(prev => ({ ...prev, error: errorMessage }));
      return { success: false, error: errorMessage };
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Verify OTP
      const verificationToken = await verifyOtp(state.turnkeyClient, state.otpId, otpCode, state.email);

      // Login with verification token and get sub-org ID
      const { sessionToken, subOrgId } = await loginWithOtp(state.turnkeyClient, state.email, verificationToken);

      // Fetch wallets and keys
      const wallets = await fetchWallets(state.turnkeyClient);

      setState(prev => ({
        ...prev,
        isLoading: false,
        isAuthenticated: true,
        sessionToken,
        subOrgId,
        wallets,
      }));

      return { success: true, sessionToken, subOrgId, wallets };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to verify OTP';
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
      }));
      return { success: false, error: errorMessage };
    }
  }, [state.turnkeyClient, state.otpId, state.email]);

  /**
   * Combined login flow (request + verify)
   */
  const login = useCallback(async (email: string, otpCode: string) => {
    // For cases where you want to handle both steps separately,
    // use requestOtp and verifyAndLogin instead
    const otpResult = await requestOtp(email);
    if (!otpResult.success) {
      return otpResult;
    }

    return await verifyAndLogin(otpCode);
  }, [requestOtp, verifyAndLogin]);

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
      subOrgId: null,
      wallets: [],
      otpId: null,
      verificationToken: null,
    });
  }, []);

  /**
   * Get key by curve type
   */
  const getKeyByCurveType = useCallback((curve: 'CURVE_SECP256K1' | 'CURVE_ED25519'): TurnkeyWalletAccount | null => {
    return getKeyByCurve(state.wallets, curve);
  }, [state.wallets]);

  /**
   * Get authentication key (SECP256K1)
   */
  const getAuthKey = useCallback((): TurnkeyWalletAccount | null => {
    return getKeyByCurveType('CURVE_SECP256K1');
  }, [getKeyByCurveType]);

  /**
   * Get assertion key (ED25519)
   */
  const getAssertionKey = useCallback((): TurnkeyWalletAccount | null => {
    return getKeyByCurveType('CURVE_ED25519');
  }, [getKeyByCurveType]);

  /**
   * Get update key (ED25519, second one)
   */
  const getUpdateKey = useCallback((): TurnkeyWalletAccount | null => {
    // Get all ED25519 keys
    const ed25519Keys = state.wallets.flatMap(wallet =>
      wallet.accounts.filter(account => account.curve === 'CURVE_ED25519')
    );

    // Return the second ED25519 key (index 1) if it exists
    return ed25519Keys.length > 1 ? ed25519Keys[1] : null;
  }, [state.wallets]);

  return {
    // State
    isAuthenticated: state.isAuthenticated,
    isLoading: state.isLoading,
    error: state.error,
    turnkeyClient: state.turnkeyClient,
    email: state.email,
    subOrgId: state.subOrgId,
    wallets: state.wallets,

    // Methods
    requestOtp,
    verifyAndLogin,
    login,
    logout,
    getKeyByCurveType,
    getAuthKey,
    getAssertionKey,
    getUpdateKey,
  };
}
