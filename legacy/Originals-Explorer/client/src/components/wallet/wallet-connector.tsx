import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { connectWallet, getWalletInfo } from "@/lib/wallet";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export function WalletConnector() {
  const [isConnecting, setIsConnecting] = useState(false);
  const { toast } = useToast();
  
  // Check for dev auth first, then use mock user ID
  const isDevAuth = localStorage.getItem('dev-auth') === 'true';
  const devUserId = localStorage.getItem('dev-user-id');
  const mockUserId = isDevAuth ? devUserId : "user_123";

  const { data: walletConnection } = useQuery<{ walletAddress: string; walletType: string }>({
    queryKey: ["/api/wallet", mockUserId],
    enabled: !!mockUserId,
  });

  const connectWalletMutation = useMutation({
    mutationFn: async (walletData: { walletAddress: string; walletType: string }) => {
      return apiRequest("POST", "/api/wallet/connect", {
        ...walletData,
        userId: mockUserId,
      });
    },
    onSuccess: () => {
      toast({
        title: "Wallet Connected",
        description: "Your wallet has been successfully connected.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Connection Failed",
        description: error.message || "Failed to connect wallet. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleConnectWallet = async () => {
    try {
      setIsConnecting(true);
      const walletInfo = await connectWallet();
      
      if (walletInfo) {
        await connectWalletMutation.mutateAsync(walletInfo);
      }
    } catch (error: any) {
      toast({
        title: "Connection Error",
        description: error.message || "Failed to connect to wallet.",
        variant: "destructive",
      });
    } finally {
      setIsConnecting(false);
    }
  };

  if (walletConnection) {
    return (
      <div className="flex items-center space-x-2 text-sm">
        <div className="w-2 h-2 bg-green-500 rounded-full"></div>
        <span className="text-gray-600 font-mono text-xs">
          {walletConnection.walletAddress.slice(0, 6)}...{walletConnection.walletAddress.slice(-4)}
        </span>
      </div>
    );
  }

  // Show dev user status if logged in with dev auth
  if (isDevAuth) {
    return (
      <div className="flex items-center space-x-2 text-sm">
        <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
        <span className="text-gray-600 text-xs">
          Dev User
        </span>
        <button
          onClick={() => {
            localStorage.removeItem('dev-auth');
            localStorage.removeItem('dev-user-id');
            window.location.href = '/login';
          }}
          className="text-gray-500 hover:text-gray-700 text-xs underline"
          data-testid="dev-logout-button"
        >
          Logout
        </button>
      </div>
    );
  }

  return (
    <Link href="/login">
      <button
        className="minimal-button"
        data-testid="login-button"
      >
        Login
      </button>
    </Link>
  );
}
