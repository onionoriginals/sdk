import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';

interface User {
  id: string;
  did: string;
  email: string;
  turnkeySubOrgId: string;
}

export function useAuth() {
  const queryClient = useQueryClient();

  // Check authentication by trying to fetch user data
  // The JWT cookie is automatically sent with the request
  const { data: serverUser, isLoading, error } = useQuery<User>({
    queryKey: ['/api/user'],
    queryFn: async () => {
      const response = await fetch('/api/user', {
        credentials: 'include', // Include cookies
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
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('Logout failed');
      }
      return response.json();
    },
    onSuccess: () => {
      // Clear all queries to prevent data leakage
      queryClient.clear();
    },
  });

  const isAuthenticated = !!serverUser && !error;

  return {
    user: serverUser ? {
      id: serverUser.id,
      email: serverUser.email,
      did: serverUser.did,
      turnkeySubOrgId: serverUser.turnkeySubOrgId,
    } : null,
    isLoading,
    isAuthenticated,
    logout: () => logoutMutation.mutate(),
  };
}