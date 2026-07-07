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
import { getOrCreateTurnkeySubOrg, normalizeEmail } from './turnkey-client.js';

// Session timeout (15 minutes to match Turnkey OTP)
const SESSION_TIMEOUT = 15 * 60 * 1000;

// Maximum failed OTP verification attempts before the session is destroyed.
// Limits local brute-forcing of the 6-digit code instead of relying solely
// on Turnkey's server-side throttling.
const MAX_OTP_ATTEMPTS = 5;

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
 *
 * No Turnkey resources are provisioned here: the sub-organization (and its
 * wallet) is only created in {@link verifyEmailAuth}, after the caller has
 * proven control of the email address by presenting a valid OTP code.
 *
 * **Rate limiting is the caller's responsibility.** This function sends an
 * email on every call. Endpoints exposing it MUST enforce rate limits (per
 * IP and per target email) to prevent OTP email bombing of arbitrary
 * inboxes; Turnkey's per-`userIdentifier` throttle does not protect
 * arbitrary recipient addresses from an attacker who varies the email.
 */
export async function initiateEmailAuth(
  email: string,
  turnkeyClient: Turnkey,
  sessionStorage?: SessionStorage
): Promise<InitiateAuthResult> {
  const storage = sessionStorage ?? getDefaultSessionStorage();

  // Normalize before validation and all Turnkey calls so the same mailbox
  // always maps to the same identity (Alice@x.com === alice@x.com).
  const normalizedEmail = normalizeEmail(email);

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    throw new Error('Invalid email format');
  }

  console.log('[email-auth] Initiating email auth');

  // Send OTP via Turnkey. Sub-org creation is deliberately deferred to
  // verifyEmailAuth: creating billable sub-orgs/wallets for unproven emails
  // would let an unauthenticated attacker mass-provision resources.

  // Generate a unique user identifier for rate limiting
  const data = new TextEncoder().encode(normalizedEmail);
  const hash = sha256(data);
  const userIdentifier = bytesToHex(hash);

  const otpResult = await turnkeyClient.apiClient().initOtp({
    otpType: 'OTP_TYPE_EMAIL',
    contact: normalizedEmail,
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

  // Create auth session. subOrgId is intentionally absent until the email
  // is verified (see verifyEmailAuth).
  const sessionId = generateSessionId();
  storage.set(sessionId, {
    email: normalizedEmail,
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
   * Compressed P-256 public key (hex) supplied by the client, to which the
   * Turnkey verification token will be bound. When provided, the matching
   * private key never leaves the client: the verify result contains no
   * `privateKey`, so nothing sensitive transits the HTTP response.
   *
   * When omitted, an ephemeral keypair is generated server-side and its
   * private key is returned in the result. This is a fallback for
   * server-only flows — for browser clients, always generate the keypair in
   * the browser and pass its public key here.
   */
  publicKey?: string;
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
 * On success this also provisions the user's Turnkey sub-organization (get
 * or create) — deferred from initiation so that resources are only created
 * for proven email addresses.
 *
 * Returns the `verificationToken` together with the public key it is bound
 * to. When no client `publicKey` was supplied (see
 * {@link VerifyEmailAuthOptions}), the server-generated ephemeral private
 * key is also returned, which the caller needs to complete a subsequent
 * `otpLogin`.
 *
 * Failed verification attempts are counted per session; after
 * {@link MAX_OTP_ATTEMPTS} failures the session is destroyed and the user
 * must request a new code.
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

  // Encrypt the OTP code (plus a client public key) to the target encryption
  // bundle. Turnkey v6 verifyOtp only accepts encrypted bundles. This also
  // verifies the enclave signature on the target bundle. The verification
  // token Turnkey issues is BOUND to the public key embedded in the bundle:
  // either the client-supplied one (preferred — its private key never leaves
  // the client) or a server-generated ephemeral keypair that must be
  // surfaced to the caller for a subsequent otpLogin.
  let encryptedOtpBundle: string;
  let publicKey: string;
  let privateKey: string | undefined;
  try {
    ({ encryptedOtpBundle, publicKey, privateKey } = await encryptOtpCode({
      otpCode: code,
      otpEncryptionTargetBundle: session.otpEncryptionTargetBundle,
      publicKey: options?.publicKey,
      dangerouslyOverrideSignerPublicKey: options?.dangerouslyOverrideSignerPublicKey,
    }));
  } catch (error) {
    console.error('❌ Failed to encrypt OTP code:', error);
    throw new Error(
      `Failed to encrypt OTP code: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let verificationToken: string;
  try {
    // Verify the encrypted OTP bundle with Turnkey.
    //
    // NOTE (org context): this activity intentionally carries no
    // organizationId override, so it runs under the PARENT organization —
    // the same org context that ran initOtp. Turnkey's documented flow
    // keeps initOtp/verifyOtp at the parent org and uses the sub-org only
    // for the subsequent otpLogin; routing verifyOtp to the sub-org while
    // initOtp ran at the parent relied on undocumented otpId scoping (and
    // the sub-org may not even exist yet, since provisioning is deferred
    // until after verification).
    const verifyResult = await turnkeyClient.apiClient().verifyOtp({
      otpId: session.otpId,
      encryptedOtpBundle,
      expirationSeconds: '900', // 15 minutes
    });

    if (!verifyResult.verificationToken) {
      throw new Error('OTP verification failed - no verification token returned');
    }

    verificationToken = verifyResult.verificationToken;
  } catch (error) {
    console.error('❌ OTP verification failed:', error);

    // Count the failed attempt; destroy the session once the budget is
    // spent so the otpId cannot be brute-forced for the rest of the
    // 15-minute window.
    const attempts = (session.otpAttempts ?? 0) + 1;
    if (attempts >= MAX_OTP_ATTEMPTS) {
      storage.delete(sessionId);
      throw new Error(
        'Too many failed verification attempts. Please request a new code.'
      );
    }
    session.otpAttempts = attempts;
    storage.set(sessionId, session);

    throw new Error(
      `Invalid verification code: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log('[email-auth] OTP verified successfully');

  // Email ownership is now proven — provision the Turnkey sub-organization
  // (deferred from initiateEmailAuth to prevent unauthenticated resource
  // creation).
  let subOrgId: string;
  try {
    subOrgId = await getOrCreateTurnkeySubOrg(session.email, turnkeyClient);
  } catch (error) {
    throw new Error(
      `Email verified, but provisioning the Turnkey sub-organization failed: ${
        error instanceof Error ? error.message : String(error)
      }. Please request a new code and try again.`,
      { cause: error }
    );
  }

  // Mark session as verified
  session.verified = true;
  session.subOrgId = subOrgId;
  storage.set(sessionId, session);

  return {
    verified: true,
    email: session.email,
    subOrgId,
    verificationToken,
    publicKey,
    privateKey,
  };
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
 *
 * Note: `subOrgId` is only present on sessions that have completed
 * verification — initiation no longer provisions the sub-organization.
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
