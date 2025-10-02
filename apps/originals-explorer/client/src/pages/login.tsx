import { useAuth } from "@/hooks/useAuth";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useEffect } from "react";

export default function Login() {
  const { user, isLoading, isUserLoading, isAuthenticated, login } = useAuth();
  const { toast } = useToast();

  // Store return path and redirect after login
  useEffect(() => {
    // Store where user should return to after login
    if (!isAuthenticated) {
      const returnTo = new URLSearchParams(window.location.search).get('returnTo') || '/';
      sessionStorage.setItem('loginReturnTo', returnTo);
    }
    
    // Redirect to return path after successful login
    if (isAuthenticated && user) {
      toast({
        title: "Login Successful",
        description: "Welcome back!",
      });
      
      const returnTo = sessionStorage.getItem('loginReturnTo') || '/';
      sessionStorage.removeItem('loginReturnTo');
      window.location.href = returnTo;
    }
  }, [isAuthenticated, user, toast]);

  const handleLogin = async () => {
    try {
      await login();
    } catch (error) {
      toast({
        title: "Login Failed",
        description: "Please try again.",
        variant: "destructive",
      });
    }
  };

  if (isLoading || isUserLoading) {
    return (
      <main className="min-h-screen bg-white flex items-center justify-center px-4">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-8">
        <div className="bg-white shadow-sm border border-gray-200 rounded-sm p-8">
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-gray-900">
                Welcome to Originals
              </h2>
              <p className="mt-2 text-sm text-gray-600">
                Sign in to create and manage your digital assets
              </p>
            </div>

            <Button
              onClick={handleLogin}
              disabled={isLoading}
              className="w-full bg-gray-900 hover:bg-gray-800 text-white"
              data-testid="privy-login-button"
            >
              {isLoading ? "Connecting..." : "Sign In"}
            </Button>

            <div className="text-center text-xs text-gray-500">
              <p>
                Sign in with email, social accounts, or connect your wallet
              </p>
            </div>
          </div>
        </div>

        <div className="text-center">
          <Link href="/" className="text-sm text-gray-600 hover:text-gray-900">
            ← Back to Home
          </Link>
        </div>
      </div>
    </main>
  );
}