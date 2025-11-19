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
      // Try to get existing sub-organizations by email filter
      const subOrgs = await turnkeyClient.apiClient().getSubOrgIds({
        organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
        filterType: 'EMAIL',
        filterValue: email,
      });

      const subOrgIds = subOrgs.organizationIds || [];
      const existingSubOrgId = subOrgIds.length > 0 ? subOrgIds[0] : null;

      if (existingSubOrgId) {
        console.log(`✅ Found existing sub-organization: ${existingSubOrgId}`);

        // Check if this sub-org has a wallet - if not, it was created before wallet implementation
        console.log(`🔍 Checking if sub-org has wallet...`);
        try {
          const walletsCheck = await turnkeyClient.apiClient().getWallets({
            organizationId: existingSubOrgId,
          });
          const walletCount = walletsCheck.wallets?.length || 0;
          console.log(`Found ${walletCount} wallet(s) in existing sub-org`);

          if (walletCount === 0) {
            console.log(`⚠️ Sub-org has no wallet. This sub-org was created before wallet creation was implemented.`);
            console.log(`📝 Parent org cannot delete sub-orgs due to Turnkey security model.`);
            console.log(`📝 Creating new sub-org with wallet instead...`);
            // Continue below to create a new sub-org with a timestamp to avoid collision
          } else {
            // Sub-org has wallet, use it
            return existingSubOrgId;
          }
        } catch (walletCheckErr) {
          console.error('Could not check wallet in sub-org:', walletCheckErr);
          // If we can't check wallets, assume sub-org is fine and return it
          return existingSubOrgId;
        }

        // If we reach here and the sub-org wasn't returned above, it means we deleted it
        // Continue below to create a new one
      }
    } catch (lookupError) {
      console.log(`📝 No existing sub-org found, will create new one`);
    }

    // Generate a unique name for the new sub-org (with timestamp)
    const subOrgName = `${baseSubOrgName}-${Date.now()}`;

    console.log(`📧 Creating new Turnkey sub-organization for ${email}...`);

    // Create sub-organization with a wallet containing the keys we need
    // Turnkey allows parent orgs to create wallets DURING sub-org creation
    // The wallet accounts will be owned by the sub-org (non-custodial)
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
      wallet: {
        walletName: 'default-wallet',
        accounts: [
          {
            curve: 'CURVE_SECP256K1',
            pathFormat: 'PATH_FORMAT_BIP32',
            path: "m/44'/0'/0'/0/0", // Standard Bitcoin path for auth-key
            addressFormat: 'ADDRESS_FORMAT_ETHEREUM', // Secp256k1 - use Ethereum format
          },
          {
            curve: 'CURVE_ED25519',
            pathFormat: 'PATH_FORMAT_BIP32',
            path: "m/44'/501'/0'/0'", // Standard Solana path (Ed25519) for assertion-key
            addressFormat: 'ADDRESS_FORMAT_SOLANA', // Ed25519 - use Solana format
          },
          {
            curve: 'CURVE_ED25519',
            pathFormat: 'PATH_FORMAT_BIP32',
            path: "m/44'/501'/1'/0'", // Different path for update-key
            addressFormat: 'ADDRESS_FORMAT_SOLANA', // Ed25519 - use Solana format
          },
        ],
      },
    });

    const subOrgId = result.activity?.result?.createSubOrganizationResultV7?.subOrganizationId;

    if (!subOrgId) {
      throw new Error('No sub-organization ID returned from Turnkey');
    }

    console.log(`✅ Created sub-organization: ${subOrgId}`);
    console.log(`📝 Keys will be created after OTP verification`);

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

  // Step 2: Send OTP via Turnkey using the turnkeyClient API
  console.log(`📨 Sending OTP to ${email} via Turnkey...`);

  // Generate a unique user identifier for rate limiting
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { bytesToHex } = await import('@noble/hashes/utils.js');
  const data = new TextEncoder().encode(email);
  const hash = sha256(data);
  const userIdentifier = bytesToHex(hash);

  const otpResult = await turnkeyClient.apiClient().initOtp({
    otpType: 'OTP_TYPE_EMAIL',
    contact: email,
    userIdentifier: userIdentifier,
    emailCustomization: {
      appName: 'Originals Explorer',
    },
    otpLength: 6,
    alphanumeric: false, // Use numeric only for easier entry
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
    // Verify the OTP code with Turnkey using the turnkeyClient API
    const verifyResult = await turnkeyClient.apiClient().verifyOtp({
      otpId: session.otpId,
      otpCode: code,
      expirationSeconds: '900', // 15 minutes
    });

    if (!verifyResult.verificationToken) {
      throw new Error('OTP verification failed - no verification token returned');
    }

    console.log(`✅ OTP verified successfully! Token: ${verifyResult.verificationToken.substring(0, 20)}...`);

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
