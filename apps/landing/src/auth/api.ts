import { sendOtp, verifyOtp } from '@originals/auth/client';
import { generateP256KeyPair } from '@turnkey/crypto';

export interface AuthUser {
  subOrgId: string;
  email: string;
}

export async function startOtp(email: string): Promise<{ sessionId: string; message: string }> {
  return sendOtp(email); // POST /api/auth/send-otp (default endpoint)
}

export async function completeOtp(
  sessionId: string,
  code: string
): Promise<{ verified: boolean; email: string; subOrgId: string }> {
  // Generate the P-256 keypair in the browser so the verification-token
  // private key never transits HTTP (2.0 token binding).
  const keyPair = generateP256KeyPair();
  const result = await verifyOtp(sessionId, code, undefined, { publicKey: keyPair.publicKey });
  return { verified: result.verified, email: result.email!, subOrgId: result.subOrgId! };
}

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (!res.ok) return null;
  return (await res.json()) as AuthUser;
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
}
