import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../auth/jwt";
import { storage } from "../storage";

/**
 * Authentication middleware using JWT from HTTP-only cookies
 * CRITICAL PR #102: Uses cookies (not localStorage) for security
 */
export const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get JWT token from HTTP-only cookie
    const token = req.cookies?.auth_token;

    if (!token) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Verify JWT token
    const payload = verifyToken(token);
    const turnkeySubOrgId = payload.sub; // Turnkey organization ID (sub-org ID) - stable identifier
    const email = payload.email; // Email metadata

    // Check if user already exists by Turnkey sub-org ID
    let user = await storage.getUserByTurnkeyId(turnkeySubOrgId);

    // If user doesn't exist, create user record with temporary DID
    // User will create their actual DID via frontend signing flow
    if (!user) {
      console.log(`Creating user record for ${email}...`);

      // Use temporary DID as placeholder until user creates real DID via frontend
      // This ensures each user has a unique identifier in storage
      const temporaryDid = `temp:turnkey:${turnkeySubOrgId}`;

      // Create user with temporary DID - they'll replace it via frontend signing
      user = await storage.createUserWithDid(turnkeySubOrgId, email, temporaryDid, {
        did: temporaryDid,
        didDocument: null,
        authKeyId: null,
        assertionKeyId: null,
        updateKeyId: null,
        authKeyPublic: null,
        assertionKeyPublic: null,
        updateKeyPublic: null,
        didCreatedAt: null,
        didSlug: null,
        didLog: null,
      });

      console.log(`✅ User created: ${email}`);
      console.log(`   Turnkey sub-org ID: ${turnkeySubOrgId}`);
      console.log(`   Temporary DID: ${temporaryDid}`);
      console.log(`   Real DID will be created via frontend signing flow`);
    }

    // Add user info to request with database ID as primary identifier
    (req as any).user = {
      id: user.id, // Primary identifier is the database UUID (for foreign keys)
      turnkeySubOrgId, // Turnkey sub-org ID for key operations
      email, // Email metadata
      did: user.did, // DID for display/lookup
      sessionToken: payload.sessionToken, // User's Turnkey session token for API calls
    };

    next();
  } catch (error) {
    console.error("Authentication error:", error);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
