/**
 * Turnkey Email Authentication Service
 * Implements email-based authentication using Turnkey's OTP flow
 */

import { randomBytes } from 'node:crypto';
import { Turnkey } from '@turnkey/sdk-server';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { EmailAuthSession, InitiateAuthResult, VerifyAuthResult } from '../types.js';
import { encryptOtpCode } from '../otp-encryption.js';
import { getOrCreateTurnkeySubOrg } from './turnkey-client.js';

// Session timeout (15 minutes to match Turnkey OTP)
const SESSION_TIMEOUT = 15 * 60 * 1000;

/**
 * Session storage interface for pluggable session management
 */
export interface SessionStorage {
  get(sessionId: string): EmailAuthSession | undefined;
  set(sessionId: string, session: EmailAuthSession): void;
  delete(sessionId: string): void;
  cleanup(): void;
}

/**
 * Create an in-memory session storage.
 *
 * **Production warning**: This store is ephemeral — sessions are lost on
 * process restart and are not shared across multiple instances. For
 * production deployments, pass a persistent {@link SessionStorage}
 * implementation backed by Redis, a database, or another shared store.
 */
export function createInMemorySessionStorage(): SessionStorage {
  const sessions = new Map<string, EmailAuthSession>();

  // Start cleanup interval
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions.entries()) {
      if (now - session.timestamp > SESSION_TIMEOUT) {
        sessions.delete(sessionId);
      }
    }
  }, 60 * 1000);

  // Keep the interval from preventing process exit
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return {
    get: (sessionId: string) => sessions.get(sessionId),
    set: (sessionId: string, session: EmailAuthSession) => sessions.set(sessionId, session),
    delete: (sessionId: string) => sessions.delete(sessionId),
    cleanup: () => {
      clearInterval(cleanupInterval);
      sessions.clear();
    },
  };
}

// Default session storage
let defaultSessionStorage: SessionStorage | null = null;

function getDefaultSessionStorage(): SessionStorage {
  if (!defaultSessionStorage) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[auth] Using in-memory session storage in production: sessions are lost on restart ' +
          'and not shared across instances. Pass a persistent SessionStorage.'
      );
    }
    defaultSessionStorage = createInMemorySessionStorage();
  }
  return defaultSessionStorage;
}

/**
 * Generate a cryptographically secure random session ID
 */
function generateSessionId(): string {
  return `session_${randomBytes(24).toString('base64url')}`;
}

/**
 * Initiate email authentication using Turnkey OTP
 * Sends a 6-digit OTP code to the user's email
 */
export async function initiateEmailAuth(
  email: string,
  turnkeyClient: Turnkey,
  sessionStorage?: SessionStorage
): Promise<InitiateAuthResult> {
  const storage = sessionStorage ?? getDefaultSessionStorage();

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error('Invalid email format');
  }

  console.log('[email-auth] Initiating email auth');

  // Step 1: Get or create Turnkey sub-organization
  const subOrgId = await getOrCreateTurnkeySubOrg(email, turnkeyClient);

  // Step 2: Send OTP via Turnkey

  // Generate a unique user identifier for rate limiting
  const data = new TextEncoder().encode(email);
  const hash = sha256(data);
  const userIdentifier = bytesToHex(hash);

  const otpResult = await turnkeyClient.apiClient().initOtp({
    otpType: 'OTP_TYPE_EMAIL',
    contact: email,
    userIdentifier: userIdentifier,
    appName: 'Originals',
    otpLength: 6,
    alphanumeric: false,
  });

  const otpId = otpResult.otpId;

  if (!otpId) {
    throw new Error('Failed to initiate OTP - no OTP ID returned');
  }

  // Turnkey v6 (ACTIVITY_TYPE_INIT_OTP_V3) returns a signed target-encryption
  // bundle; the OTP code must be encrypted to it during verification.
  const otpEncryptionTargetBundle = otpResult.otpEncryptionTargetBundle;

  if (!otpEncryptionTargetBundle) {
    throw new Error('Failed to initiate OTP - no OTP encryption target bundle returned');
  }

  console.log('[email-auth] OTP sent');

  // Create auth session
  const sessionId = generateSessionId();
  storage.set(sessionId, {
    email,
    subOrgId,
    otpId,
    otpEncryptionTargetBundle,
    timestamp: Date.now(),
    verified: false,
  });

  return {
    sessionId,
    message: 'Verification code sent to your email. Check your inbox!',
  };
}

/**
 * Options for {@link verifyEmailAuth}.
 */
export interface VerifyEmailAuthOptions {
  /**
   * Override for the enclave signing key used to verify the OTP encryption
   * target bundle's signature before encrypting the OTP code. ONLY for tests
   * or non-production Turnkey environments; defaults to Turnkey's production
   * signer key.
   */
  dangerouslyOverrideSignerPublicKey?: string;
}

/**
 * Verify email authentication code using Turnkey OTP
 *
 * Implements the Turnkey v6 encrypted-bundle flow: the OTP code is encrypted
 * to the `otpEncryptionTargetBundle` captured during {@link initiateEmailAuth}
 * and submitted as `encryptedOtpBundle` to Turnkey's `verifyOtp` activity.
 *
 * Returns the `verificationToken` together with the ephemeral P-256 keypair
 * it is bound to (`publicKey`/`privateKey`), which the caller needs to
 * complete a subsequent `otpLogin`.
 */
export async function verifyEmailAuth(
  sessionId: string,
  code: string,
  turnkeyClient: Turnkey,
  sessionStorage?: SessionStorage,
  options?: VerifyEmailAuthOptions
): Promise<VerifyAuthResult> {
  const storage = sessionStorage ?? getDefaultSessionStorage();
  const session = storage.get(sessionId);

  if (!session) {
    throw new Error('Invalid or expired session');
  }

  // Check if session has expired
  if (Date.now() - session.timestamp > SESSION_TIMEOUT) {
    storage.delete(sessionId);
    throw new Error('Session expired. Please request a new code.');
  }

  if (!session.otpId) {
    throw new Error('OTP ID not found in session');
  }

  if (!session.subOrgId) {
    throw new Error('Sub-organization ID not found');
  }

  if (!session.otpEncryptionTargetBundle) {
    throw new Error(
      'OTP encryption target bundle not found in session. Please request a new code.'
    );
  }

  // Reject malformed or oversized codes before hitting Turnkey
  if (!/^[A-Za-z0-9]{4,10}$/.test(code)) {
    throw new Error('Invalid verification code format');
  }

  console.log('[email-auth] Verifying OTP');

  // Encrypt the OTP code (plus an ephemeral client public key) to the target
  // encryption bundle. Turnkey v6 verifyOtp only accepts encrypted bundles.
  // This also verifies the enclave signature on the target bundle. The
  // verification token Turnkey issues is BOUND to the ephemeral public key
  // embedded in the bundle, so the keypair must be surfaced to the caller
  // for a subsequent otpLogin.
  let encryptedOtpBundle: string;
  let publicKey: string;
  let privateKey: string | undefined;
  try {
    ({ encryptedOtpBundle, publicKey, privateKey } = await encryptOtpCode({
      otpCode: code,
      otpEncryptionTargetBundle: session.otpEncryptionTargetBundle,
      dangerouslyOverrideSignerPublicKey: options?.dangerouslyOverrideSignerPublicKey,
    }));
  } catch (error) {
    console.error('❌ Failed to encrypt OTP code:', error);
    throw new Error(
      `Failed to encrypt OTP code: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    // Verify the encrypted OTP bundle with Turnkey
    const verifyResult = await turnkeyClient.apiClient().verifyOtp({
      otpId: session.otpId,
      encryptedOtpBundle,
      expirationSeconds: '900', // 15 minutes
      // Route the VERIFY_OTP_V2 activity under the user's sub-organization,
      // mirroring the client-side completeOtp path. subOrgId is validated
      // non-null above; without it Turnkey v6 can reject the activity for
      // missing org context.
      organizationId: session.subOrgId,
    });

    if (!verifyResult.verificationToken) {
      throw new Error('OTP verification failed - no verification token returned');
    }

    console.log('[email-auth] OTP verified successfully');

    // Mark session as verified
    session.verified = true;
    storage.set(sessionId, session);

    return {
      verified: true,
      email: session.email,
      subOrgId: session.subOrgId,
      verificationToken: verifyResult.verificationToken,
      publicKey,
      privateKey,
    };
  } catch (error) {
    console.error('❌ OTP verification failed:', error);
    throw new Error(
      `Invalid verification code: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Check if a session is verified
 */
export function isSessionVerified(
  sessionId: string,
  sessionStorage?: SessionStorage
): boolean {
  const storage = sessionStorage ?? getDefaultSessionStorage();
  const session = storage.get(sessionId);

  if (!session) return false;

  if (Date.now() - session.timestamp > SESSION_TIMEOUT) {
    storage.delete(sessionId);
    return false;
  }

  return session.verified;
}

/**
 * Clean up a session after successful login
 */
export function cleanupSession(
  sessionId: string,
  sessionStorage?: SessionStorage
): void {
  const storage = sessionStorage ?? getDefaultSessionStorage();
  storage.delete(sessionId);
}

/**
 * Get session data
 */
export function getSession(
  sessionId: string,
  sessionStorage?: SessionStorage
): EmailAuthSession | undefined {
  const storage = sessionStorage ?? getDefaultSessionStorage();
  const session = storage.get(sessionId);

  if (!session) return undefined;

  // Check if expired
  if (Date.now() - session.timestamp > SESSION_TIMEOUT) {
    storage.delete(sessionId);
    return undefined;
  }

  return session;
}

