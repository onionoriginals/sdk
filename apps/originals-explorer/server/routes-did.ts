/**
 * DID Routes - Simplified DID creation using didwebvh-ts
 */

import { Express } from 'express';
import { storage } from './storage';

/**
 * Mount DID routes on the Express app
 */
export function mountDIDRoutes(app: Express, authenticateUser: any) {

  // Get user's multibase-encoded public keys for DID creation
  app.get("/api/did/keys", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;

      // Check if user already has keys stored
      if (user.authKeyPublic && user.assertionKeyPublic && user.updateKeyPublic) {
        return res.json({
          authKey: user.authKeyPublic,
          assertionKey: user.assertionKeyPublic,
          updateKey: user.updateKeyPublic,
          userSlug: user.email, // Use email as slug for now
        });
      }

      // If no keys stored, return error - keys should be created during sign up
      return res.status(404).json({
        error: "No keys found. Please contact support."
      });

    } catch (error) {
      console.error("Error getting keys:", error);
      res.status(500).json({
        error: "Failed to get keys",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Submit and verify DID log from frontend
  app.post("/api/did/submit-log", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      const { did, didDocument, didLog } = req.body;

      if (!did || !didDocument || !didLog) {
        return res.status(400).json({
          error: "Missing required fields: did, didDocument, didLog"
        });
      }

      // Validate DID format
      if (!did.startsWith('did:webvh:')) {
        return res.status(400).json({
          error: "Invalid DID format: must be did:webvh"
        });
      }

      // Verify the DID log using didwebvh-ts
      try {
        const { verifyLog } = await import('didwebvh-ts');

        // Verify the log is valid
        const isValid = await verifyLog(didLog);

        if (!isValid) {
          return res.status(400).json({
            error: "Invalid DID log: verification failed"
          });
        }
      } catch (verifyError) {
        console.error("DID log verification error:", verifyError);
        return res.status(400).json({
          error: "Failed to verify DID log",
          message: verifyError instanceof Error ? verifyError.message : String(verifyError)
        });
      }

      // Convert log to JSONL format for storage
      const logEntries = Array.isArray(didLog) ? didLog : [didLog];
      const didLogJsonl = logEntries.map(entry => JSON.stringify(entry)).join('\n');

      // Check if user has temporary DID
      const hasTemporaryDid = user.did && user.did.startsWith('temp:');

      if (hasTemporaryDid) {
        // Migrate from temporary DID to real DID
        console.log(`Migrating user from temporary DID ${user.did} to real DID ${did}`);

        await storage.createUserWithDid(user.turnkeySubOrgId, user.email!, did, {
          did: did,
          didDocument: didDocument,
          didLog: didLogJsonl,
          didSlug: null,
          authKeyId: user.authWalletId,
          assertionKeyId: user.assertionWalletId,
          updateKeyId: user.updateWalletId,
          authKeyPublic: user.authKeyPublic,
          assertionKeyPublic: user.assertionKeyPublic,
          updateKeyPublic: user.updateKeyPublic,
          didCreatedAt: new Date(),
        });

        console.log(`✅ Successfully migrated user to real DID: ${did}`);
      } else {
        // Update existing DID
        await storage.updateUserDid(user.turnkeySubOrgId, {
          did: did,
          didDocument: didDocument,
          didLog: didLogJsonl,
        });

        console.log(`✅ Updated DID for user: ${did}`);
      }

      res.json({
        success: true,
        did: did,
        message: "DID created and verified successfully"
      });

    } catch (error) {
      console.error("Error submitting DID log:", error);
      res.status(500).json({
        error: "Failed to submit DID log",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
