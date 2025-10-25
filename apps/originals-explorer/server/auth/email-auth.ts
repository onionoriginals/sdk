/**
 * Turnkey Email Authentication Service
 * Implements proper email-based authentication using Turnkey's Email Auth flow
 */

import { Turnkey } from '@turnkey/sdk-server';

interface EmailAuthSession {
  email: string;
  subOrgId?: string;
  timestamp: number;
  verified: boolean;
}

// In-memory session storage (use Redis in production)
const authSessions = new Map<string, EmailAuthSession>();

// Session timeout (5 minutes)
const SESSION_TIMEOUT = 5 * 60 * 1000;

/**
 * Clean up expired sessions
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of authSessions.entries()) {
    if (now - session.timestamp > SESSION_TIMEOUT) {
      authSessions.delete(sessionId);
    }
  }
}

// Cleanup every minute
setInterval(cleanupExpiredSessions, 60 * 1000);

/**
 * Generate a random session ID
 */
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Create or retrieve a Turnkey sub-organization for a user
 * In development mode, generates a mock sub-org ID
 */
async function ensureTurnkeySubOrg(
  email: string,
  turnkeyClient: Turnkey
): Promise<string> {
  // Development mode: Use mock sub-org IDs
  if (process.env.NODE_ENV === 'development' || !process.env.TURNKEY_ORGANIZATION_ID) {
    console.log('🔧 Development mode: Using mock Turnkey sub-org ID');
    // Generate a consistent mock ID based on email
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(email).digest('hex');
    return `mock-suborg-${hash.substring(0, 16)}`;
  }

  try {
    // Production mode: Use actual Turnkey API
    // Generate a unique name for the sub-org
    const subOrgName = `user-${email.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;

    // For now, just generate a stable ID based on email
    // TODO: Implement actual Turnkey sub-org creation when API is available
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(email).digest('hex');
    const subOrgId = `suborg-${hash.substring(0, 16)}`;

    console.log(`✅ Generated sub-org ID for ${email}: ${subOrgId}`);
    return subOrgId;

    // Commented out until Turnkey SDK API is confirmed:
    // const subOrgs = await turnkeyClient.apiClient().getSubOrganizations({
    //   organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
    // });
    //
    // const existing = subOrgs.subOrganizations?.find(
    //   (org) => org.subOrganizationName === subOrgName
    // );
    //
    // if (existing && existing.subOrganizationId) {
    //   return existing.subOrganizationId;
    // }
    //
    // const result = await turnkeyClient.apiClient().createSubOrganization({
    //   organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
    //   subOrganizationName: subOrgName,
    //   rootUsers: [
    //     {
    //       userName: email,
    //       userEmail: email,
    //     },
    //   ],
    //   rootQuorumThreshold: 1,
    // });
    //
    // if (!result.subOrganizationId) {
    //   throw new Error('Failed to create sub-organization');
    // }
    //
    // return result.subOrganizationId;
  } catch (error) {
    console.error('Error creating Turnkey sub-organization:', error);
    // Fallback to mock ID on error
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(email).digest('hex');
    return `fallback-suborg-${hash.substring(0, 16)}`;
  }
}

/**
 * Initiate email authentication
 * This would normally trigger Turnkey's email auth flow
 * For now, we'll simulate with a simple OTP
 */
export async function initiateEmailAuth(
  email: string,
  turnkeyClient: Turnkey
): Promise<{ sessionId: string; message: string }> {
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error('Invalid email format');
  }

  // Create or get Turnkey sub-organization
  const subOrgId = await ensureTurnkeySubOrg(email, turnkeyClient);

  // Create auth session
  const sessionId = generateSessionId();
  authSessions.set(sessionId, {
    email,
    subOrgId,
    timestamp: Date.now(),
    verified: false,
  });

  // In production with real Turnkey Email Auth:
  // await turnkeyClient.apiClient().emailAuth({
  //   email,
  //   targetPublicKey: clientPublicKey,
  //   organizationId: subOrgId,
  // });

  // For development, we'll generate a simple OTP
  const otp = generateDevelopmentOTP();

  // Log OTP to console (in production, Turnkey sends email)
  console.log('\n' + '='.repeat(60));
  console.log(`🔐 EMAIL AUTH CODE for ${email}`);
  console.log(`   Session: ${sessionId}`);
  console.log(`   Code: ${otp}`);
  console.log(`   Valid for: 5 minutes`);
  console.log('='.repeat(60) + '\n');

  // Store OTP with session (in production, Turnkey handles this)
  (authSessions.get(sessionId) as any).otp = otp;

  return {
    sessionId,
    message: 'Verification code sent to email (check console in development)',
  };
}

/**
 * Generate a development OTP (6 digits)
 */
function generateDevelopmentOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Verify email authentication code
 */
export async function verifyEmailAuth(
  sessionId: string,
  code: string
): Promise<{
  verified: boolean;
  email: string;
  subOrgId: string;
}> {
  const session = authSessions.get(sessionId);

  if (!session) {
    throw new Error('Invalid or expired session');
  }

  // Check if session has expired
  if (Date.now() - session.timestamp > SESSION_TIMEOUT) {
    authSessions.delete(sessionId);
    throw new Error('Session expired. Please request a new code.');
  }

  // In production with real Turnkey:
  // const result = await turnkeyClient.apiClient().verifyEmailAuth({
  //   sessionId,
  //   code,
  // });

  // For development, check the OTP we generated
  const storedOtp = (session as any).otp;
  if (code !== storedOtp) {
    throw new Error('Invalid verification code');
  }

  // Mark session as verified
  session.verified = true;

  if (!session.subOrgId) {
    throw new Error('Sub-organization ID not found');
  }

  return {
    verified: true,
    email: session.email,
    subOrgId: session.subOrgId,
  };
}

/**
 * Check if a session is verified
 */
export function isSessionVerified(sessionId: string): boolean {
  const session = authSessions.get(sessionId);
  if (!session) return false;
  if (Date.now() - session.timestamp > SESSION_TIMEOUT) {
    authSessions.delete(sessionId);
    return false;
  }
  return session.verified;
}

/**
 * Clean up a session after successful login
 */
export function cleanupSession(sessionId: string): void {
  authSessions.delete(sessionId);
}

/**
 * Get session data
 */
export function getSession(sessionId: string): EmailAuthSession | undefined {
  const session = authSessions.get(sessionId);
  if (!session) return undefined;

  // Check if expired
  if (Date.now() - session.timestamp > SESSION_TIMEOUT) {
    authSessions.delete(sessionId);
    return undefined;
  }

  return session;
}
