import { usePrivy, useCreateWallet } from "@privy-io/react-auth";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { User, Mail, Wallet, Settings, LogOut, X, Plus, Key } from "lucide-react";
import { Link } from "wouter";

export default function Profile() {
  const { user, authenticated, ready, logout } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { toast } = useToast();
  
  const isLoading = !ready;
  const isAuthenticated = ready && authenticated;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-2 text-gray-600">Loading profile...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle>Authentication Required</CardTitle>
            <CardDescription>
              Please sign in to view your profile
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Link href="/login">
              <Button data-testid="profile-login-button">
                Sign In
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const initials = user?.email?.address 
    ? user.email.address.split('@')[0].slice(0, 2).toUpperCase()
    : 'U';

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Account Modal */}
        <Card className="bg-white shadow-lg border-0 rounded-2xl">
          <CardContent className="p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-gray-900" data-testid="profile-title">
                Account
              </h2>
              <Link href="/">
                <button className="text-gray-400 hover:text-gray-600" data-testid="profile-close-button">
                  <X className="w-5 h-5" />
                </button>
              </Link>
            </div>

            {/* User Email */}
            <div className="flex items-center gap-3 mb-4 p-3 hover:bg-gray-50 rounded-lg transition-colors">
              <Mail className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-900" data-testid="profile-email-display">
                {user?.email?.address || 'No email address'}
              </span>
            </div>

            {/* Settings */}
            <div className="flex items-center gap-3 mb-4 p-3 hover:bg-gray-50 rounded-lg transition-colors cursor-pointer">
              <Settings className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-900">Settings</span>
            </div>

            {/* Log out */}
            <div 
              className="flex items-center gap-3 mb-6 p-3 hover:bg-gray-50 rounded-lg transition-colors cursor-pointer"
              onClick={logout}
              data-testid="profile-logout-button"
            >
              <LogOut className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-900">Log out</span>
            </div>

            <Separator className="mb-6" />

            {/* Wallet Section */}
            <div className="mb-6">
              <div className="text-xs text-gray-500 mb-3">Your wallets</div>
              {user?.linkedAccounts?.some((account: any) => account.type === 'wallet') ? (
                <div className="space-y-2">
                  {user.linkedAccounts
                    .filter((account: any) => account.type === 'wallet')
                    .map((wallet: any, index: number) => (
                      <div key={wallet.address || index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-center gap-2">
                          <Wallet className="w-4 h-4 text-gray-500" />
                          <div className="flex flex-col">
                            <span className="text-sm font-mono text-gray-900" data-testid={`profile-wallet-address-${index}`}>
                              {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}
                            </span>
                            <span className="text-xs text-gray-500">
                             {wallet.walletClientType || wallet.chainType || 'wallet'}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              ) : user?.wallet?.address ? (
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-gray-500" />
                    <span className="text-sm font-mono text-gray-900" data-testid="profile-wallet-address">
                      {user.wallet.address.slice(0, 6)}...{user.wallet.address.slice(-4)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500">0.063 ETH</div>
                </div>
              ) : (
                <div className="text-sm text-gray-500 text-center py-4">
                  No wallets connected
                </div>
              )}
            </div>

            {/* Add Funds Button */}
            <Button 
              className="w-full bg-gray-900 hover:bg-gray-800 text-white rounded-lg mb-6" 
              data-testid="profile-add-funds-button"
            >
              Add funds
            </Button>

            {/* Create Both Wallets Button */}
            <Button
              className="w-full bg-purple-600 hover:bg-purple-700 text-white rounded-lg mb-3"
              onClick={async () => {
                try {
                  const res = await apiRequest("POST", "/api/wallets/create-both");
                  const data = await res.json();
                  console.log("Bitcoin and Stellar wallets created:", data);
                  toast({
                    title: "Wallets Created",
                    description: `Created ${data.wallets?.length || 2} wallets! Refreshing...`,
                  });
                  // Reload the page to fetch updated user data with new wallets
                  setTimeout(() => window.location.reload(), 1500);
                } catch (e: any) {
                  console.error("Failed to create wallets:", e);
                  toast({
                    title: "Failed to create wallets",
                    description: e?.message || "Please try again.",
                    variant: "destructive",
                  });
                }
              }}
              data-testid="profile-create-both-wallets"
            >
              <Wallet className="w-4 h-4 mr-2" />
              Create Bitcoin & Stellar Wallets
            </Button>

            {/* Create Bitcoin Wallet Button */}
            <Button
              className="w-full bg-orange-600 hover:bg-orange-700 text-white rounded-lg mb-3"
              onClick={async () => {
                try {
                  // Bitcoin requires server-side API (chainType not supported client-side)
                  const res = await apiRequest("POST", "/api/wallets/bitcoin");
                  const data = await res.json();
                  console.log("Bitcoin wallet created:", data);
                  toast({
                    title: "Bitcoin Wallet Created",
                    description: "Your BTC wallet is managed by Privy. Refreshing...",
                  });
                  setTimeout(() => window.location.reload(), 1500);
                } catch (e: any) {
                  console.error("Failed to create Bitcoin wallet:", e);
                  toast({
                    title: "Failed to create wallet",
                    description: e?.message || "Please try again.",
                    variant: "destructive",
                  });
                }
              }}
              data-testid="profile-create-btc-wallet"
            >
              <Wallet className="w-4 h-4 mr-2" />
              Create Bitcoin Wallet
            </Button>

            {/* Create Stellar Wallet (ED25519) Button */}
            <Button
              className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg mb-6"
              onClick={async () => {
                try {
                  // Stellar requires server-side API (chainType not supported client-side)
                  const res = await apiRequest("POST", "/api/wallets/stellar");
                  const data = await res.json();
                  console.log("Stellar wallet created:", data);
                  toast({
                    title: "Stellar Wallet Created",
                    description: "Your ED25519 signing wallet is managed by Privy. Refreshing...",
                  });
                  setTimeout(() => window.location.reload(), 1500);
                } catch (e: any) {
                  console.error("Failed to create Stellar wallet:", e);
                  toast({
                    title: "Failed to create wallet",
                    description: e?.message || "Please try again.",
                    variant: "destructive",
                  });
                }
              }}
              data-testid="profile-create-stellar-wallet"
            >
              <Key className="w-4 h-4 mr-2" />
              Create Stellar Wallet (ED25519)
            </Button>

            {/* Quick Actions */}
            <div className="space-y-2 mb-6">
              <Link href="/dir">
                <div className="flex items-center gap-3 p-3 hover:bg-gray-50 rounded-lg transition-colors cursor-pointer">
                  <Plus className="w-4 h-4 text-gray-500" />
                  <span className="text-sm text-gray-900" data-testid="profile-view-directory">
                    View Directory
                  </span>
                </div>
              </Link>
              
              <Link href="/create">
                <div className="flex items-center gap-3 p-3 hover:bg-gray-50 rounded-lg transition-colors cursor-pointer">
                  <Plus className="w-4 h-4 text-gray-500" />
                  <span className="text-sm text-gray-900" data-testid="profile-create-asset">
                    Create Asset
                  </span>
                </div>
              </Link>
            </div>

            {/* Protected by Privy */}
            <div className="text-center">
              <div className="text-xs text-gray-400 flex items-center justify-center gap-1">
                Protected by 
                <span className="font-semibold text-gray-600">●&nbsp;privy</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}