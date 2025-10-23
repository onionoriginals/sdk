/**
 * Authentication Hook - Turnkey Migration
 * Uses HTTP-only cookies for secure authentication
 * CRITICAL PR #102: No localStorage, all tokens in HTTP-only cookies
 */

import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';

interface ServerUser {
  id: string;
  did: string;
  email: string;
  turnkeySubOrgId: string;
}

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const queryClient = useQueryClient();

  // Fetch user from server (will fail with 401 if not authenticated)
  const { data: serverUser, isLoading: isServerUserLoading, error } = useQuery<ServerUser>({
    queryKey: ['/api/user'],
    enabled: isAuthenticated,
    retry: false,
  });

  // Check if user is authenticated on mount
  useEffect(() => {
    // Try to fetch user data to see if we have a valid cookie
    fetch('/api/user', {
      credentials: 'include',
    })
      .then(res => {
        if (res.ok) {
          setIsAuthenticated(true);
        } else {
          setIsAuthenticated(false);
        }
      })
      .catch(() => {
        setIsAuthenticated(false);
      })
      .finally(() => {
        setIsCheckingAuth(false);
      });
  }, []);

  // Login function - calls /api/auth/login
  const login = useCallback(async (email: string) => {
    try {
      const response = await apiRequest('POST', '/api/auth/login', { email });

      if (response.ok) {
        setIsAuthenticated(true);
        // Invalidate queries to refetch with new auth
        queryClient.invalidateQueries();
      } else {
        throw new Error('Login failed');
      }
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  }, [queryClient]);

  // Logout function - calls /api/auth/logout
  const logout = useCallback(async () => {
    try {
      await apiRequest('POST', '/api/auth/logout');
      setIsAuthenticated(false);
      // Clear all cached data
      queryClient.clear();
    } catch (error) {
      console.error('Logout error:', error);
      // Still clear auth state on error
      setIsAuthenticated(false);
      queryClient.clear();
    }
  }, [queryClient]);

  return {
    user: serverUser || null,
    isLoading: isCheckingAuth,
    isUserLoading: isAuthenticated && isServerUserLoading,
    isAuthenticated,
    login,
    logout,
  };
}
