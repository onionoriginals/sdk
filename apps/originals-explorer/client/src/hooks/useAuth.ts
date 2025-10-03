import { usePrivy } from '@privy-io/react-auth';
import { useQuery } from '@tanstack/react-query';

export function useAuth() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();

  // Always call useQuery to maintain hook order consistency
  const { data: serverUser, isLoading: isServerUserLoading } = useQuery({
    queryKey: ['/api/user'],
    enabled: ready && authenticated,
    retry: false,
  });

  // Return consistent structure regardless of auth state
  const isAuthenticated = ready && authenticated;
  
  return {
    user: isAuthenticated && user && serverUser ? {
      id: serverUser.id,
      email: user.email?.address,
      wallet: user.wallet?.address,
      privyId: user.id,
    } : null,
    isLoading: !ready,
    isUserLoading: isAuthenticated && isServerUserLoading,
    isAuthenticated,
    login,
    logout,
    getAccessToken,
  };
}