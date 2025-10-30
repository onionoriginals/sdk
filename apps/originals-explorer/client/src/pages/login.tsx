import { useAuth } from "@/hooks/useAuth";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { useTurnkeyAuth } from "@/hooks/useTurnkeyAuth";
import { useTurnkeySession } from "@/contexts/TurnkeySessionContext";

type AuthStep = 'email' | 'code';

export default function Login() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const { toast } = useToast();
  const turnkeyAuth = useTurnkeyAuth();
  const { setSession } = useTurnkeySession();

  const [step, setStep] = useState<AuthStep>('email');
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
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

  const handleEmailSubmit = async (e: React.FormEvent) => {
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
      // Use browser-side Turnkey OTP
      const result = await turnkeyAuth.requestOtp(email);

      if (result.success) {
        setStep('code');
        toast({
          title: "Verification Code Sent",
          description: "Check your email for the verification code.",
        });
      } else {
        toast({
          title: "Failed to Send Code",
          description: result.error || "Please try again.",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Connection Error",
        description: "Failed to initiate authentication.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate code
    if (!code.trim()) {
      toast({
        title: "Code Required",
        description: "Please enter the verification code.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      // Step 1: Verify OTP with browser-side Turnkey
      const loginResult = await turnkeyAuth.verifyAndLogin(code.trim());

      if (!loginResult.success) {
        toast({
          title: "Verification Failed",
          description: loginResult.error || "Invalid code. Please try again.",
          variant: "destructive",
        });
        setIsSubmitting(false);
        return;
      }

      // Step 2: Store Turnkey session in context for signing operations
      setSession({
        client: turnkeyAuth.turnkeyClient,
        email: turnkeyAuth.email,
        sessionToken: loginResult.sessionToken,
        wallets: loginResult.wallets || [],
      });

      // Step 3: Exchange Turnkey session for JWT cookie
      const response = await apiRequest('POST', '/api/auth/exchange-session', {
        email: turnkeyAuth.email,
        sessionToken: loginResult.sessionToken,
      });

      if (response.ok) {
        // Success - JWT cookie is set, Turnkey session is stored
        toast({
          title: "Login Successful",
          description: "Welcome back!",
        });
        // Force a page reload to pick up the new auth state
        setTimeout(() => window.location.reload(), 500);
      } else {
        const error = await response.json();
        toast({
          title: "Login Failed",
          description: error.details || "Failed to complete login. Please try again.",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Verification Error",
        description: "Failed to verify code.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBack = () => {
    setStep('email');
    setCode('');
  };

  if (isLoading) {
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
          {step === 'email' ? (
            <form onSubmit={handleEmailSubmit} className="space-y-6">
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
                  data-testid="email-input"
                />
              </div>

              <Button
                type="submit"
                disabled={isSubmitting || !email.trim()}
                className="w-full bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-400"
                data-testid="send-code-button"
              >
                {isSubmitting ? "Sending Code..." : "Send Verification Code"}
              </Button>

              <div className="text-center text-xs text-gray-500">
                <p>
                  Secure email authentication powered by Turnkey
                </p>
              </div>
            </form>
          ) : (
            <form onSubmit={handleCodeSubmit} className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-semibold text-gray-900">
                  Enter Verification Code
                </h2>
                <p className="mt-2 text-sm text-gray-600">
                  We sent a 6-digit code to <strong>{email}</strong>
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="code" className="text-sm font-medium text-gray-700">
                  Verification Code
                </Label>
                <Input
                  id="code"
                  type="text"
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.slice(0, 6))}
                  disabled={isSubmitting}
                  className="w-full text-center text-2xl tracking-widest font-mono"
                  autoComplete="one-time-code"
                  required
                  maxLength={6}
                  autoFocus
                  data-testid="code-input"
                />
                <p className="text-xs text-gray-500 text-center">
                  In development, check the server console for the code
                </p>
              </div>

              <Button
                type="submit"
                disabled={isSubmitting || code.length !== 6}
                className="w-full bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-400"
                data-testid="verify-code-button"
              >
                {isSubmitting ? "Verifying..." : "Verify & Sign In"}
              </Button>

              <Button
                type="button"
                onClick={handleBack}
                disabled={isSubmitting}
                variant="outline"
                className="w-full"
                data-testid="back-button"
              >
                ← Use Different Email
              </Button>

              <div className="text-center text-xs text-gray-500">
                <p>
                  Didn't receive a code?{" "}
                  <button
                    type="button"
                    onClick={handleEmailSubmit}
                    disabled={isSubmitting}
                    className="text-gray-900 font-medium hover:underline"
                  >
                    Resend
                  </button>
                </p>
              </div>
            </form>
          )}
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
