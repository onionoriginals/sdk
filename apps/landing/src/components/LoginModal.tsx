import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../auth/useAuth';
import { demo } from '../content';
import { OtpInput } from './OtpInput';
import './login-modal.css';

type Step = 'email' | 'otp';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { startOtp, verify, reauth, user } = useAuth();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset to the email step whenever the modal closes, so a reopen never lands
  // on a stale OTP step with the wrong email.
  useEffect(() => {
    if (!open) {
      setStep('email');
      setEmail('');
      setError(null);
    }
  }, [open]);

  // Re-authentication is a signing-session refresh for a user who is already
  // signed in: the email is known and beginReauth() already sent the code, so
  // asking for the address again would be a step that does nothing.
  useEffect(() => {
    if (open && reauth.active && user) {
      setEmail(user.email);
      setStep('otp');
    }
  }, [open, reauth.active, user]);

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
            <h2>{reauth.active ? demo.session.expiredHeading : 'Enter your code'}</h2>
            <p className="login-sub">
              {reauth.active ? `${demo.session.preserved} Sent to ${email}` : `Sent to ${email}`}
            </p>
            <OtpInput onComplete={submitCode} isLoading={busy} error={error} onResend={() => submitEmail(new Event('submit') as unknown as FormEvent)} />
          </div>
        )}
      </div>
    </div>
  );
}
