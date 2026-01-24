/**
 * Client-side helpers for server-proxied authentication
 * Use these when your server handles Turnkey API keys
 *
 * @example
 * ```typescript
 * import { sendOtp, verifyOtp } from '@originals/auth/client';
 *
 * // Send OTP to user's email via your server
 * const { sessionId } = await sendOtp('user@example.com');
 *
 * // Verify the code they enter
 * const { verified, email, subOrgId } = await verifyOtp(sessionId, '123456');
 * ```
 */

import type { InitiateAuthResult, VerifyAuthResult } from '../types';

/**
 * Options for server-proxied auth functions
 */
export interface ServerAuthOptions {
  /** Custom fetch function (for testing) */
  fetch?: typeof fetch;
}

/**
 * Send OTP via your server endpoint
 * Server should call initiateEmailAuth() from @originals/auth/server
 *
 * @param email - User's email address
 * @param endpoint - Server endpoint URL (default: '/api/auth/send-otp')
 * @param options - Optional configuration
 * @returns Promise with sessionId and message
 *
 * @example
 * ```typescript
 * const { sessionId, message } = await sendOtp('user@example.com');
 * // sessionId is used for verification step
 * // message is user-friendly text to display
 * ```
 */
export async function sendOtp(
  email: string,
  endpoint = '/api/auth/send-otp',
  options?: ServerAuthOptions
): Promise<InitiateAuthResult> {
  const fetchFn = options?.fetch ?? fetch;
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to send OTP' })) as { message?: string };
    throw new Error(error.message ?? `HTTP ${response.status}`);
  }

  return response.json() as Promise<InitiateAuthResult>;
}

/**
 * Verify OTP via your server endpoint
 * Server should call verifyEmailAuth() from @originals/auth/server
 *
 * @param sessionId - Session ID from sendOtp result
 * @param code - OTP code entered by user
 * @param endpoint - Server endpoint URL (default: '/api/auth/verify-otp')
 * @param options - Optional configuration
 * @returns Promise with verification result
 *
 * @example
 * ```typescript
 * const { verified, email, subOrgId } = await verifyOtp(sessionId, '123456');
 * if (verified) {
 *   // User is authenticated
 *   console.log(`Authenticated: ${email}`);
 * }
 * ```
 */
export async function verifyOtp(
  sessionId: string,
  code: string,
  endpoint = '/api/auth/verify-otp',
  options?: ServerAuthOptions
): Promise<VerifyAuthResult> {
  const fetchFn = options?.fetch ?? fetch;
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, code }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Verification failed' })) as { message?: string };
    throw new Error(error.message ?? `HTTP ${response.status}`);
  }

  return response.json() as Promise<VerifyAuthResult>;
}
