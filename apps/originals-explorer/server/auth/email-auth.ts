/**
 * Turnkey Email Authentication Service
 * Implements proper email-based authentication using Turnkey's OTP flow
 */

import { Turnkey } from '@turnkey/sdk-server';

interface EmailAuthSession {
  email: string;
  subOrgId?: string;
  otpId?: string;
  timestamp: number;
  verified: boolean;
}

// In-memory session storage (use Redis in production)
const authSessions = new Map<string, EmailAuthSession>();

// Session timeout (15 minutes to match Turnkey OTP)
const SESSION_TIMEOUT = 15 * 60 * 1000;

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
 * Get or create a Turnkey sub-organization for a user
 * Uses the proper Turnkey SDK to create sub-orgs with email-only root users
 */
async function getOrCreateTurnkeySubOrg(
  email: string,
  turnkeyClient: Turnkey
): Promise<string> {
  try {
    // First, check if a sub-org already exists for this email
    // Generate a consistent name based on email (without timestamp for lookup)
    const baseSubOrgName = `user-${email.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;

    console.log(`🔍 Checking for existing sub-organization for ${email}...`);

    try {
      // Try to get existing sub-organizations
      const subOrgs = await turnkeyClient.apiClient().getSubOrganizations();

      // Look for existing sub-org with matching name pattern
      const existing = subOrgs.subOrganizations?.find(
        (org) => org.subOrganizationName?.startsWith(baseSubOrgName)
      );

      if (existing && existing.subOrganizationId) {
        console.log(`✅ Found existing sub-organization: ${existing.subOrganizationId}`);
        return existing.subOrganizationId;
      }
    } catch (lookupError) {
      console.log(`📝 No existing sub-org found, will create new one`);
    }

    // Generate a unique name for the new sub-org (with timestamp)
    const subOrgName = `${baseSubOrgName}-${Date.now()}`;

    console.log(`📧 Creating new Turnkey sub-organization for ${email}...`);

    // Create sub-organization using the Turnkey SDK
    // Using the correct parameter structure for Turnkey API
    const result = await turnkeyClient.apiClient().createSubOrganization({
      subOrganizationName: subOrgName,
      rootUsers: [
        {
          userName: email,
          userEmail: email,
          apiKeys: [],
          authenticators: [],
          oauthProviders: [],
        },
      ],
      rootQuorumThreshold: 1,
    });

    const subOrgId = result.activity?.result?.createSubOrganizationResultV7?.subOrganizationId;

    if (!subOrgId) {
      throw new Error('No sub-organization ID returned from Turnkey');
    }

    console.log(`✅ Created sub-organization: ${subOrgId}`);
    return subOrgId;
  } catch (error) {
    console.error('❌ Error creating Turnkey sub-organization:', error);
    throw new Error(
      `Failed to create Turnkey sub-organization: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Initiate email authentication using Turnkey OTP
 * Sends a 6-digit OTP code to the user's email
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

  console.log(`\n🚀 Initiating email auth for: ${email}`);

  // Step 1: Get or create Turnkey sub-organization
  // We need to create this first so we have a valid sub-org ID
  const subOrgId = await getOrCreateTurnkeySubOrg(email, turnkeyClient);

  // Step 2: Send OTP via Turnkey
  console.log(`📨 Sending OTP to ${email} via Turnkey...`);

  const otpResult = await turnkeyClient.sendOtp({
    organizationId: subOrgId,
    otpType: 'OTP_TYPE_EMAIL',
    contact: email,
    emailCustomization: {
      appName: 'Originals Explorer',
    },
    userIdentifier: email, // For rate limiting
    expirationSeconds: '900', // 15 minutes
  });

  const otpId = otpResult.otpId;

  if (!otpId) {
    throw new Error('Failed to initiate OTP - no OTP ID returned');
  }

  console.log(`✅ OTP sent! OTP ID: ${otpId}`);

  // Create auth session
  const sessionId = generateSessionId();
  authSessions.set(sessionId, {
    email,
    subOrgId,
    otpId,
    timestamp: Date.now(),
    verified: false,
  });

  console.log('='.repeat(60));
  console.log(`📧 Check ${email} for the verification code!`);
  console.log(`   Session ID: ${sessionId}`);
  console.log(`   OTP ID: ${otpId}`);
  console.log(`   Valid for: 15 minutes`);
  console.log('='.repeat(60) + '\n');

  return {
    sessionId,
    message: 'Verification code sent to your email. Check your inbox!',
  };
}

/**
 * Generate a development OTP (6 digits)
 */
function generateDevelopmentOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Verify email authentication code using Turnkey OTP
 */
export async function verifyEmailAuth(
  sessionId: string,
  code: string,
  turnkeyClient: Turnkey
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

  if (!session.otpId) {
    throw new Error('OTP ID not found in session');
  }

  if (!session.subOrgId) {
    throw new Error('Sub-organization ID not found');
  }

  console.log(`\n🔐 Verifying OTP for session ${sessionId}...`);

  try {
    // Verify the OTP code with Turnkey
    const verifyResult = await turnkeyClient.verifyOtp({
      organizationId: session.subOrgId,
      otpId: session.otpId,
      otpCode: code,
    });

    if (!verifyResult.verificationToken) {
      throw new Error('OTP verification failed - no verification token returned');
    }

    console.log(`✅ OTP verified successfully!`);

    // Mark session as verified
    session.verified = true;

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
