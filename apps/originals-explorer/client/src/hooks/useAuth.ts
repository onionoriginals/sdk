import { useTurnkey } from '@turnkey/sdk-react';
import { useQuery } from '@tanstack/react-query';
import { useState, useEffect, useCallback } from 'react';

export function useAuth() {
  const turnkey = useTurnkey();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [ready, setReady] = useState(false);

  // Check for existing token on mount
  useEffect(() => {
    const token = localStorage.getItem('turnkey_token');
    setIsAuthenticated(!!token);
    setReady(true);
  }, []);

  // Always call useQuery to maintain hook order consistency
  const { data: serverUser, isLoading: isServerUserLoading } = useQuery({
    queryKey: ['/api/user'],
    enabled: ready && isAuthenticated,
    retry: false,
  });

  const login = useCallback(async (email: string) => {
    // This is a simplified login flow
    // In production, implement proper Turnkey email auth or passkey flow
    // For now, create a simple token for testing
    const token = btoa(JSON.stringify({ sub: email, userId: email, timestamp: Date.now() }));
    localStorage.setItem('turnkey_token', token);
    localStorage.setItem('turnkey_email', email);
    setIsAuthenticated(true);
    return token;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('turnkey_token');
    localStorage.removeItem('turnkey_email');
    setIsAuthenticated(false);
  }, []);

  const getAccessToken = useCallback(async () => {
    return localStorage.getItem('turnkey_token') || '';
  }, []);

  return {
    user: isAuthenticated && serverUser ? {
      id: serverUser.id,
      email: localStorage.getItem('turnkey_email') || undefined,
      turnkeyUserId: serverUser.turnkeyUserId,
      did: serverUser.did,
    } : null,
    isLoading: !ready,
    isUserLoading: isAuthenticated && isServerUserLoading,
    isAuthenticated,
    login,
    logout,
    getAccessToken,
    turnkey, // Expose Turnkey SDK for advanced usage
  };
}