import { useAuth } from "@/hooks/useAuth";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Login() {
  const { user, isLoading, isUserLoading, isAuthenticated, login } = useAuth();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate email
    if (!email.trim()) {
      toast({
        title: "Email Required",
        description: "Please enter your email address.",
        variant: "destructive",
      });
      return;
    }

    if (!email.includes("@")) {
      toast({
        title: "Invalid Email",
        description: "Please enter a valid email address.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await login(email);
    } catch (error) {
      toast({
        title: "Login Failed",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
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
          <form onSubmit={handleLogin} className="space-y-6">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-gray-900">
                Welcome to Originals
              </h2>
              <p className="mt-2 text-sm text-gray-600">
                Sign in with your email to create and manage your digital assets
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium text-gray-700">
                Email Address
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isSubmitting}
                className="w-full"
                autoComplete="email"
                required
              />
            </div>

            <Button
              type="submit"
              disabled={isSubmitting || !email.trim()}
              className="w-full bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-400"
              data-testid="login-button"
            >
              {isSubmitting ? "Signing in..." : "Sign In"}
            </Button>

            <div className="text-center text-xs text-gray-500">
              <p>
                Secure authentication powered by Turnkey
              </p>
            </div>
          </form>
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