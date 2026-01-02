/**
 * Authentication hook for checking auth state
 * Uses React Query to manage auth state and caching
 */

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { AuthUser } from '../../types';

interface UseAuthOptions {
  /** Base URL for API requests (default: '') */
  apiBaseUrl?: string;
  /** User endpoint path (default: '/api/user') */
  userEndpoint?: string;
  /** Logout endpoint path (default: '/api/auth/logout') */
  logoutEndpoint?: string;
}

interface UseAuthReturn {
  /** Current authenticated user or null */
  user: AuthUser | null;
  /** Whether auth check is in progress */
  isLoading: boolean;
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Logout function */
  logout: () => void;
  /** Whether logout is in progress */
  isLoggingOut: boolean;
  /** Refetch user data */
  refetch: () => Promise<unknown>;
}

/**
 * Hook for managing authentication state
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { user, isLoading, isAuthenticated, logout } = useAuth();
 *
 *   if (isLoading) return <div>Loading...</div>;
 *
 *   if (!isAuthenticated) {
 *     return <LoginForm />;
 *   }
 *
 *   return (
 *     <div>
 *       <p>Welcome, {user.email}!</p>
 *       <button onClick={logout}>Logout</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useAuth(options: UseAuthOptions = {}): UseAuthReturn {
  const { apiBaseUrl = '', userEndpoint = '/api/user', logoutEndpoint = '/api/auth/logout' } =
    options;

  const queryClient = useQueryClient();

  // Check authentication by fetching user data
  const {
    data: user,
    isLoading,
    error,
    refetch,
  } = useQuery<AuthUser>({
    queryKey: [userEndpoint],
    queryFn: async () => {
      const response = await fetch(`${apiBaseUrl}${userEndpoint}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Not authenticated');
      }

      return response.json();
    },
    retry: false,
    staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
  });

  // Logout mutation
  const logoutMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${apiBaseUrl}${logoutEndpoint}`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Logout failed');
      }

      return response.json();
    },
    onSuccess: () => {
      // Clear user data immediately
      queryClient.setQueryData([userEndpoint], null);
      queryClient.invalidateQueries({ queryKey: [userEndpoint] });
      queryClient.resetQueries({ queryKey: [userEndpoint] });
      // Clear all queries to prevent data leakage
      queryClient.clear();
    },
  });

  const isAuthenticated = !!user && !error;

  return {
    user: user ?? null,
    isLoading,
    isAuthenticated,
    logout: () => logoutMutation.mutate(),
    isLoggingOut: logoutMutation.isPending,
    refetch,
  };
}



