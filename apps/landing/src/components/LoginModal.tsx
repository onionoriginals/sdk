import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/useAuth';
import { OtpInput } from './OtpInput';
import './login-modal.css';

type Step = 'email' | 'otp';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { startOtp, verify } = useAuth();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) return setError('Please enter a valid email address');
    setBusy(true);
    try {
      await startOtp(value);
      setStep('otp');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (code: string) => {
    setError(null);
    setBusy(true);
    try {
      await verify(code);
      onClose();
      setStep('email');
      setEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="login-modal" onClick={(e) => e.stopPropagation()}>
        <button className="login-close" aria-label="Close" onClick={onClose}>×</button>
        {step === 'email' ? (
          <form onSubmit={submitEmail} className="login-form">
            <h2>Sign in</h2>
            <p className="login-sub">We'll email you a 6-digit code.</p>
            <input
              type="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="login-email"
            />
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        ) : (
          <div className="login-form">
            <h2>Enter your code</h2>
            <p className="login-sub">Sent to {email}</p>
            <OtpInput onComplete={submitCode} isLoading={busy} error={error} onResend={() => submitEmail(new Event('submit') as unknown as FormEvent)} />
          </div>
        )}
      </div>
    </div>
  );
}
