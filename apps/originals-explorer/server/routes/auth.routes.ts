import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { Turnkey } from "@turnkey/sdk-server";
import { signToken, getAuthCookieConfig, getClearAuthCookieConfig } from "../auth/jwt";
import { initiateEmailAuth, verifyEmailAuth, cleanupSession } from "../auth/email-auth";

const router = Router();

// Temporary in-memory storage for OTP codes (legacy fallback)
const otpStorage = new Map<string, { code: string; expires: number }>();

// Google OAuth2 client
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/auth/google/callback'
);

// Turnkey client for key management
const turnkeyClient = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID!,
});

/**
 * PRIMARY AUTH FLOW - Turnkey Email Authentication
 */

// Step 1: Initiate email authentication
// Sends verification code to user's email (via Turnkey in production, console in dev)
router.post("/initiate", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: "Email is required" });
    }

    // Initiate email auth flow
    const result = await initiateEmailAuth(email, turnkeyClient);

    res.json({
      success: true,
      sessionId: result.sessionId,
      message: result.message,
    });
  } catch (error) {
    console.error("Email auth initiation error:", error);
    res.status(500).json({
      error: "Failed to initiate authentication",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Step 2: Verify email code and complete login
// User submits the code they received, server verifies and issues JWT
router.post("/verify", async (req, res) => {
  try {
    const { sessionId, code } = req.body;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: "Session ID is required" });
    }

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: "Verification code is required" });
    }

    // Verify the code with Turnkey
    const verification = await verifyEmailAuth(sessionId, code, turnkeyClient);

    if (!verification.verified) {
      return res.status(401).json({ error: "Invalid verification code" });
    }

    // Sign JWT token with sub-org ID
    const token = signToken(verification.subOrgId, verification.email);

    // Set HTTP-only cookie
    const cookieConfig = getAuthCookieConfig(token);
    res.cookie(cookieConfig.name, cookieConfig.value, cookieConfig.options);

    // Clean up the session
    cleanupSession(sessionId);

    res.json({
      success: true,
      message: "Authentication successful",
    });
  } catch (error) {
    console.error("Email verification error:", error);
    res.status(401).json({
      error: "Verification failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Exchange Turnkey session token for JWT cookie
// This enables browser-side Turnkey authentication while maintaining server-side auth
router.post("/exchange-session", async (req, res) => {
  try {
    const { email, userId, sessionToken } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: "Email is required" });
    }

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: "User ID is required" });
    }

    if (!sessionToken || typeof sessionToken !== 'string') {
      return res.status(400).json({ error: "Session token is required" });
    }

    // Sign JWT token with Turnkey organization ID as the subject (stable identifier)
    // organizationId is the user's Turnkey sub-org ID
    // Include session token so we can use user's credentials for Turnkey API calls
    const token = signToken(userId, email, sessionToken);

    // Set HTTP-only cookie
    const cookieConfig = getAuthCookieConfig(token);
    res.cookie(cookieConfig.name, cookieConfig.value, cookieConfig.options);

    res.json({
      success: true,
      message: "Authentication successful",
    });
  } catch (error) {
    console.error("Session exchange error:", error);
    res.status(500).json({
      error: "Failed to exchange session",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Logout endpoint - clears HTTP-only cookie
router.post("/logout", (_req, res) => {
  const clearConfig = getClearAuthCookieConfig();
  res.cookie(clearConfig.name, clearConfig.value, clearConfig.options);
  res.json({ success: true, message: "Logged out successfully" });
});

/**
 * LEGACY AUTH FLOW - OTP Fallback
 */

router.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    // Generate 6-digit OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 5 * 60 * 1000; // 5 minutes

    // Store OTP (in production, use Redis or database)
    otpStorage.set(email, { code, expires });

    // In production, send email with actual email service
    console.log('\n' + '='.repeat(50));
    console.log(`🔐 DEMO OTP CODE for ${email}: ${code}`);
    console.log('='.repeat(50) + '\n');

    res.json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    console.error("Error sending OTP:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

router.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP are required" });
    }

    const storedOtp = otpStorage.get(email);
    if (!storedOtp) {
      return res.status(400).json({ error: "OTP not found or expired" });
    }

    if (Date.now() > storedOtp.expires) {
      otpStorage.delete(email);
      return res.status(400).json({ error: "OTP expired" });
    }

    if (storedOtp.code !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    // OTP is valid, clean up
    otpStorage.delete(email);

    // In production, create JWT token or session
    res.json({
      success: true,
      message: "Authentication successful",
      user: { email }
    });
  } catch (error) {
    console.error("Error verifying OTP:", error);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

/**
 * GOOGLE OAUTH FLOW
 */

router.get("/google", async (req, res) => {
  try {
    const authUrl = googleClient.generateAuthUrl({
      access_type: 'offline',
      scope: ['email', 'profile'],
      prompt: 'consent'
    });
    res.redirect(authUrl);
  } catch (error) {
    console.error("Error generating Google auth URL:", error);
    res.status(500).json({ error: "Failed to initiate Google authentication" });
  }
});

router.get("/google/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ error: "Authorization code required" });
    }

    const { tokens } = await googleClient.getToken(code as string);
    googleClient.setCredentials(tokens);

    // Get user info
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token!,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return res.status(400).json({ error: "Invalid token payload" });
    }

    // In production, create JWT token or session
    const user = {
      email: payload.email,
      name: payload.name,
      picture: payload.picture
    };

    // Redirect to frontend with success
    res.redirect('/?auth=success');
  } catch (error) {
    console.error("Error in Google OAuth callback:", error);
    res.redirect('/?auth=error');
  }
});

export default router;
