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
    const turnkeySubOrgId = payload.sub; // Turnkey sub-org ID (stable identifier)
    const email = payload.email; // Email metadata

    // Check if user already exists by Turnkey sub-org ID
    let user = await storage.getUserByTurnkeyId(turnkeySubOrgId);

    // If user doesn't exist, create user record
    // Note: DID creation is skipped for now because it requires client-side signing
    // with the user's Turnkey credentials (parent org cannot sign with sub-org keys)
    if (!user) {
      console.log(`Creating user record for ${email}...`);

      // Create user without DID for now
      // TODO: Implement client-side DID creation flow
      const placeholderDid = `temp:${turnkeySubOrgId}`;
      user = await storage.createUserWithDid(turnkeySubOrgId, email, placeholderDid, {
        did: placeholderDid,
        didDocument: null,
        authKeyId: null,
        assertionKeyId: null,
        updateKeyId: null,
        authKeyPublic: null,
        assertionKeyPublic: null,
        updateKeyPublic: null,
        didCreatedAt: new Date(),
        didSlug: null,
        didLog: null,
      });

      console.log(`✅ User created with Turnkey sub-org: ${turnkeySubOrgId}`);
    }

    // Add user info to request with database ID as primary identifier
    (req as any).user = {
      id: user.id, // Primary identifier is the database UUID (for foreign keys)
      turnkeySubOrgId, // Turnkey sub-org ID for key operations
      email, // Email metadata
      did: user.did, // DID for display/lookup
    };

    next();
  } catch (error) {
    console.error("Authentication error:", error);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
