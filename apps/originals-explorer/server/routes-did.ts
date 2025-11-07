/**
 * DID Routes - Simplified DID creation using didwebvh-ts
 */

import { Express } from 'express';
import { Turnkey } from '@turnkey/sdk-server';
import { storage } from './storage';
import { convertToMultibase } from './key-utils';
import OriginalsSDK, { Ed25519Verifier } from '@originals/sdk';
import { resolveDIDFromLog } from 'didwebvh-ts';
import { getWebVHService } from './webvh-integration';

/**
 * Create a Turnkey API client using user's session token
 * This allows us to make API calls on behalf of the user, not the server
 */
async function createUserTurnkeyClient(sessionToken: string, organizationId: string) {
  // For now, we'll use the server SDK but make direct HTTP requests with the session token
  // TODO: Investigate if Turnkey SDK server supports session tokens directly
  // The session token should be used as a Bearer token in API requests
  
  // Return a client-like object that can make authenticated requests
  return {
    apiClient: () => ({
      getWallets: async (params: { organizationId: string }) => {
        // Make direct HTTP request with session token
        const response = await fetch('https://api.turnkey.com/public/v1/query/get_wallets', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`,
            'X-Organization-Id': params.organizationId,
          },
          body: JSON.stringify({
            organizationId: params.organizationId,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Turnkey API error: ${response.status} - ${errorText}`);
        }

        return response.json();
      },
      getWalletAccounts: async (params: { organizationId: string; walletId: string }) => {
        const response = await fetch('https://api.turnkey.com/public/v1/query/get_wallet_accounts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`,
            'X-Organization-Id': params.organizationId,
          },
          body: JSON.stringify({
            organizationId: params.organizationId,
            walletId: params.walletId,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Turnkey API error: ${response.status} - ${errorText}`);
        }

        return response.json();
      },
    }),
  };
}

/**
 * Mount DID routes on the Express app
 */
export function mountDIDRoutes(app: Express, authenticateUser: any, turnkeyClient: Turnkey) {

  // Get user's multibase-encoded public keys for DID creation
  // Accepts keys from frontend (POST) or fetches from Turnkey/database (GET)
  app.get("/api/did/keys", authenticateUser, async (req, res) => {
    try {
      const userContext = (req as any).user;
      const turnkeySubOrgId = userContext.turnkeySubOrgId;

      // Validate turnkeySubOrgId is present
      if (!turnkeySubOrgId || typeof turnkeySubOrgId !== 'string') {
        return res.status(400).json({
          error: "Missing Turnkey sub-organization ID",
          message: "User authentication is missing the Turnkey sub-organization ID. Please log out and log back in."
        });
      }

      console.log(`[GET /api/did/keys] Request for sub-org: ${turnkeySubOrgId}`);

      // Get full user record from storage to check for stored keys
      const fullUser = await storage.getUserByTurnkeyId(turnkeySubOrgId);

      if (!fullUser) {
        console.error(`[GET /api/did/keys] User not found in database for sub-org: ${turnkeySubOrgId}`);
        return res.status(404).json({
          error: "User not found",
          message: `No user record found for Turnkey sub-org ${turnkeySubOrgId}. Please contact support.`
        });
      }

      // Verify the stored turnkeySubOrgId matches (if stored)
      if (fullUser.turnkeySubOrgId && fullUser.turnkeySubOrgId !== turnkeySubOrgId) {
        console.warn(`[GET /api/did/keys] Sub-org ID mismatch! JWT: ${turnkeySubOrgId}, DB: ${fullUser.turnkeySubOrgId}`);
        // Log but continue - use the one from JWT as it's the source of truth
      }

      // Check if user already has keys stored in database
      if (fullUser.authKeyPublic && fullUser.assertionKeyPublic && fullUser.updateKeyPublic) {
        console.log(`[GET /api/did/keys] Returning stored keys for sub-org: ${turnkeySubOrgId}`);
        return res.json({
          authKey: fullUser.authKeyPublic,
          assertionKey: fullUser.assertionKeyPublic,
          updateKey: fullUser.updateKeyPublic,
          userSlug: fullUser.email || userContext.email, // Use email as slug for now
        });
      }

      // Keys not stored - fetch them from Turnkey wallets using user's session token
      // Use the user's session token (from JWT) instead of server API keys
      const userEmail = fullUser.email || userContext.email;
      const sessionToken = userContext.sessionToken;

      if (!sessionToken) {
        console.warn(`[GET /api/did/keys] No session token found in JWT for user ${userEmail}`);
        return res.status(401).json({
          error: "Session token required",
          message: "User session token not found. Please log out and log back in to refresh your session.",
        });
      }

      console.log(`[GET /api/did/keys] Fetching keys from Turnkey using user's session token for ${userEmail} (sub-org: ${turnkeySubOrgId})`);

      try {
        // Create a Turnkey client using the user's session token
        const userTurnkeyClient = await createUserTurnkeyClient(sessionToken, turnkeySubOrgId);

        // List wallets in the sub-org using user's credentials
        console.log(`[GET /api/did/keys] Calling Turnkey getWallets for org: ${turnkeySubOrgId} with user session`);
        const walletsResult = await userTurnkeyClient.apiClient().getWallets({
          organizationId: turnkeySubOrgId,
        });

        const wallets = walletsResult.wallets || [];
        if (wallets.length === 0) {
          return res.status(404).json({
            error: "No wallets found",
            message: `No wallets found in Turnkey sub-org ${turnkeySubOrgId}. ` +
              `This may happen if the sub-org was created before wallet creation was implemented. ` +
              `Please contact support or try logging in again with a fresh account.`
          });
        }

        // Get the default wallet (first one)
        const wallet = wallets[0];
        console.log(`Using wallet: ${wallet.walletName} (${wallet.walletId})`);

        // Get wallet accounts using user's credentials
        const accountsResult = await userTurnkeyClient.apiClient().getWalletAccounts({
          organizationId: turnkeySubOrgId,
          walletId: wallet.walletId!,
        });

        const accounts = accountsResult.accounts || [];
        if (accounts.length < 3) {
          return res.status(404).json({
            error: "Insufficient wallet accounts",
            message: `Expected 3 wallet accounts but found ${accounts.length} in wallet ${wallet.walletId}. ` +
              `The wallet should contain: auth key (Secp256k1), assertion key (Ed25519), and update key (Ed25519). ` +
              `Please contact support.`
          });
        }

        // Accounts are created in order: Secp256k1, Ed25519, Ed25519
        const authAccount = accounts[0]; // CURVE_SECP256K1
        const assertionAccount = accounts[1]; // CURVE_ED25519
        const updateAccount = accounts[2]; // CURVE_ED25519

        // Convert Turnkey public keys to multibase format
        const authKeyMultibase = convertToMultibase(authAccount.publicKey || '', 'Secp256k1');
        const assertionKeyMultibase = convertToMultibase(assertionAccount.publicKey || '', 'Ed25519');
        const updateKeyMultibase = convertToMultibase(updateAccount.publicKey || '', 'Ed25519');

        // Return keys to frontend
        return res.json({
          authKey: authKeyMultibase,
          assertionKey: assertionKeyMultibase,
          updateKey: updateKeyMultibase,
          userSlug: userEmail, // Use email as slug for now
        });

      } catch (turnkeyError) {
        const errorMessage = turnkeyError instanceof Error ? turnkeyError.message : String(turnkeyError);
        console.error(`[GET /api/did/keys] Turnkey error for sub-org ${turnkeySubOrgId}:`, turnkeyError);
        
        // Check for specific error patterns
        if (errorMessage.includes('cannot load organization')) {
          return res.status(404).json({
            error: "Turnkey sub-organization not accessible",
            message: `Cannot access Turnkey sub-organization ${turnkeySubOrgId}. ` +
              `This may indicate: ` +
              `(1) The sub-org was deleted or doesn't exist, ` +
              `(2) The Turnkey API credentials don't have permission to access this sub-org, ` +
              `(3) The sub-org ID stored in the database is incorrect. ` +
              `Please contact support or try logging in again with a fresh account.`,
            turnkeySubOrgId: turnkeySubOrgId,
            details: errorMessage
          });
        }

        return res.status(500).json({
          error: "Failed to fetch keys from Turnkey",
          message: errorMessage,
            details: "Keys are not stored in the database and could not be fetched from Turnkey. " +
              "This may indicate an issue with the Turnkey sub-organization or wallet configuration. " +
              "SOLUTION: The frontend should extract keys from wallets it already has (turnkeySession.wallets) " +
              "and send them via POST /api/did/keys, or the server API keys need permission to access sub-orgs.",
            turnkeySubOrgId: turnkeySubOrgId
        });
      }

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
        // Create a verifier instance for DID log verification
        const verifier = new Ed25519Verifier();

        // Verify the log is valid
        const isValid = await resolveDIDFromLog(didLog, { verifier });

        if (!isValid) {
          return res.status(400).json({
            error: "Invalid DID log: verification failed",
            details: "The DID log signature verification failed. This may indicate the log was tampered with or signed incorrectly."
          });
        }
      } catch (verifyError) {
        console.error("[/api/did/submit-log] DID log verification error:", verifyError);
        return res.status(400).json({
          error: "Failed to verify DID log",
          message: verifyError instanceof Error ? verifyError.message : String(verifyError),
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
        // First get the user to find their ID
        const existingUser = await storage.getUserByTurnkeyId(user.turnkeySubOrgId);
        if (!existingUser) {
          return res.status(404).json({
            error: "User not found",
            message: `No user found for Turnkey sub-org ${user.turnkeySubOrgId}`
          });
        }
        
        await storage.updateUser(existingUser.id, {
          did: did,
          didDocument: didDocument,
          didLog: didLogJsonl,
        });

        console.log(`✅ Updated DID for user: ${did}`);
      }

      // Save DID log to filesystem as did.jsonl
      try {
        const webvhService = getWebVHService();
        const logPath = await webvhService.saveDIDLog(did, logEntries);
        console.log(`✅ Saved DID log to filesystem: ${logPath}`);
      } catch (saveError) {
        // Log error but don't fail the request - database storage succeeded
        console.error("Warning: Failed to save DID log to filesystem:", saveError);
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
