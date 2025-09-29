import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff } from "lucide-react";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast({
        title: "Email Required",
        description: "Please enter your email address.",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      // TODO: Send OTP to email
      await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate API call
      toast({
        title: "OTP Sent",
        description: "Check your email for the verification code.",
      });
      setStep('otp');
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to send verification code. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (otp.length !== 6) {
      toast({
        title: "Invalid Code",
        description: "Please enter the 6-digit verification code.",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      // TODO: Verify OTP and login
      await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate API call
      toast({
        title: "Login Successful",
        description: "Welcome back!",
      });
      onClose();
    } catch (error) {
      toast({
        title: "Invalid Code",
        description: "The verification code is incorrect. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setIsLoading(true);
    try {
      // TODO: Implement Google OAuth
      await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate API call
      toast({
        title: "Login Successful",
        description: "Welcome back!",
      });
      onClose();
    } catch (error) {
      toast({
        title: "Google Login Failed",
        description: "Failed to login with Google. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleBack = () => {
    setStep('email');
    setOtp('');
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md bg-gray-900 border-gray-700 text-white">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold text-white">
            {step === 'email' ? 'Login' : 'Enter Verification Code'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 pt-4">
          {step === 'email' ? (
            <>
              <form onSubmit={handleEmailSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="email" className="text-sm font-medium text-white">
                    Email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="jane@doe.net"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1 bg-gray-800 border-gray-600 text-white placeholder-gray-400 focus:border-gray-500"
                    data-testid="email-input"
                  />
                </div>

                <Button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-gray-700 hover:bg-gray-600 text-white"
                  data-testid="send-otp-button"
                >
                  {isLoading ? "Sending..." : "Send Verification Code"}
                </Button>
              </form>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-gray-600" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-gray-900 px-2 text-gray-400">or</span>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                onClick={handleGoogleLogin}
                disabled={isLoading}
                className="w-full bg-transparent border-gray-600 text-white hover:bg-gray-800"
                data-testid="google-login-button"
              >
                <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="currentColor"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
                Continue with Google
              </Button>

              <p className="text-center text-sm text-gray-400">
                Don't have an account?{" "}
                <button className="text-orange-400 hover:text-orange-300 font-medium">
                  Register
                </button>
              </p>
            </>
          ) : (
            <>
              <form onSubmit={handleOtpSubmit} className="space-y-6">
                <div className="text-center space-y-4">
                  <p className="text-sm text-gray-400">
                    We sent a 6-digit code to
                  </p>
                  <p className="font-medium text-white">{email}</p>
                  
                  <div className="flex justify-center">
                    <InputOTP
                      maxLength={6}
                      value={otp}
                      onChange={setOtp}
                      data-testid="otp-input"
                    >
                      <InputOTPGroup>
                        <InputOTPSlot index={0} className="bg-gray-800 border-gray-600 text-white" />
                        <InputOTPSlot index={1} className="bg-gray-800 border-gray-600 text-white" />
                        <InputOTPSlot index={2} className="bg-gray-800 border-gray-600 text-white" />
                        <InputOTPSlot index={3} className="bg-gray-800 border-gray-600 text-white" />
                        <InputOTPSlot index={4} className="bg-gray-800 border-gray-600 text-white" />
                        <InputOTPSlot index={5} className="bg-gray-800 border-gray-600 text-white" />
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                </div>

                <div className="space-y-3">
                  <Button
                    type="submit"
                    disabled={isLoading || otp.length !== 6}
                    className="w-full bg-gray-700 hover:bg-gray-600 text-white"
                    data-testid="verify-otp-button"
                  >
                    {isLoading ? "Verifying..." : "Verify & Login"}
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleBack}
                    className="w-full text-gray-400 hover:text-white hover:bg-gray-800"
                    data-testid="back-button"
                  >
                    Back to Email
                  </Button>
                </div>

                <div className="text-center">
                  <p className="text-sm text-gray-400">
                    Didn't receive the code?{" "}
                    <button 
                      onClick={handleEmailSubmit}
                      className="text-orange-400 hover:text-orange-300 font-medium"
                      data-testid="resend-code-button"
                    >
                      Resend
                    </button>
                  </p>
                </div>
              </form>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}