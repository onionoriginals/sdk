/**
 * Turnkey Email Authentication Service
 * Implements email-based authentication using Turnkey's OTP flow
 */

import { Turnkey } from '@turnkey/sdk-server';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { EmailAuthSession, InitiateAuthResult, VerifyAuthResult } from '../types';
import { getOrCreateTurnkeySubOrg } from './turnkey-client';

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
 * Create an in-memory session storage
 * For production, consider using Redis or a database
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
    defaultSessionStorage = createInMemorySessionStorage();
  }
  return defaultSessionStorage;
}

/**
 * Generate a random session ID
 */
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
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

  console.log(`\n🚀 Initiating email auth for: ${email}`);

  // Step 1: Get or create Turnkey sub-organization
  const subOrgId = await getOrCreateTurnkeySubOrg(email, turnkeyClient);

  // Step 2: Send OTP via Turnkey
  console.log(`📨 Sending OTP to ${email} via Turnkey...`);

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

  console.log(`✅ OTP sent! OTP ID: ${otpId}`);

  // Create auth session
  const sessionId = generateSessionId();
  storage.set(sessionId, {
    email,
    subOrgId,
    otpId,
    timestamp: Date.now(),
    verified: false,
  });

  console.log('='.repeat(60));
  console.log(`📧 Check ${email} for the verification code!`);
  console.log(`   Session ID: ${sessionId}`);
  console.log(`   Valid for: 15 minutes`);
  console.log('='.repeat(60) + '\n');

  return {
    sessionId,
    message: 'Verification code sent to your email. Check your inbox!',
  };
}

/**
 * Verify email authentication code using Turnkey OTP
 */
export async function verifyEmailAuth(
  sessionId: string,
  code: string,
  turnkeyClient: Turnkey,
  sessionStorage?: SessionStorage
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

  console.log(`\n🔐 Verifying OTP for session ${sessionId}...`);

  try {
    // Verify the OTP code with Turnkey
    const verifyResult = await turnkeyClient.apiClient().verifyOtp({
      otpId: session.otpId,
      otpCode: code,
      expirationSeconds: '900', // 15 minutes
    });

    if (!verifyResult.verificationToken) {
      throw new Error('OTP verification failed - no verification token returned');
    }

    console.log(`✅ OTP verified successfully!`);

    // Mark session as verified
    session.verified = true;
    storage.set(sessionId, session);

    return {
      verified: true,
      email: session.email,
      subOrgId: session.subOrgId,
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

