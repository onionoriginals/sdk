import { sendOtp, verifyOtp } from '@originals/auth/client';

export interface AuthUser {
  subOrgId: string;
  email: string;
}

export async function startOtp(email: string): Promise<{ sessionId: string; message: string }> {
  return sendOtp(email); // POST /api/auth/send-otp (default endpoint)
}

export interface CompleteOtpResult {
  verified: boolean;
  email: string;
  subOrgId: string;
  /** Turnkey verificationToken (bound to the P-256 pubkey below), for OTP_LOGIN. */
  verificationToken?: string;
  /** The browser session key's public half (hex). There is no private half to return. */
  p256PublicKey?: string;
}

/**
 * Verify the OTP, binding the token to `p256PublicKey`. That key is the
 * browser's NON-EXTRACTABLE session key (see ./turnkey-browser-client), minted
 * before this call because verify-otp is what binds it — and it has no
 * readable private half to hand back, here or anywhere.
 */
export async function completeOtp(
  sessionId: string,
  code: string,
  p256PublicKey?: string
): Promise<CompleteOtpResult> {
  const result = await verifyOtp(sessionId, code, undefined, { publicKey: p256PublicKey });
  return {
    verified: result.verified,
    email: result.email!,
    subOrgId: result.subOrgId!,
    verificationToken: result.verificationToken,
    p256PublicKey,
  };
}

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (!res.ok) return null;
  return (await res.json()) as AuthUser;
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
}
