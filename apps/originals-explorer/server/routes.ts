import type { Express } from "express";
import { createServer, type Server } from "http";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import { storage } from "./storage";
import { mountDIDRoutes } from "./routes-did";
import { Turnkey } from "@turnkey/sdk-server";
import { authenticateUser } from "./middleware/auth.middleware";

// Import route modules
import authRoutes from "./routes/auth.routes";
import usersRoutes from "./routes/users.routes";
import assetsRoutes from "./routes/assets.routes";
import walletRoutes from "./routes/wallet.routes";
import utilsRoutes from "./routes/utils.routes";
import devRoutes from "./routes/dev.routes";
import importRoutes from "./routes/import";

// Turnkey client for key management
const turnkeyClient = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID!,
});

/**
 * Register all API routes
 *
 * Routes are organized by domain:
 * - /api/auth/* - Authentication (Turnkey email auth, Google OAuth, legacy OTP)
 * - /api/user/* - User management
 * - /api/did/* - DID operations (via routes-did.ts)
 * - /api/assets/* - Asset CRUD, types, migration, batch operations
 * - /api/wallet/* - Wallet connections
 * - /api/import/* - Google Drive imports
 * - /api/dev/* - Development/demo endpoints (generate-random-asset)
 * - /api/* - Utilities (health, stats, QR codes)
 *
 * DID Web Hosting Routes (catch-all patterns):
 * - /.well-known/did/:slug - DID resolution (legacy)
 * - /:userSlug/did.jsonl - DID log in JSONL format
 * - /:userSlug/resources/:hash - Published resource files
 * - /:slug/did.jsonld - DID document resolution
 *
 * IMPORTANT: Catch-all routes are registered LAST to avoid conflicts
 */
export async function registerRoutes(app: Express): Promise<Server> {
  // Add cookie parser middleware for HTTP-only cookies
  app.use(cookieParser());

  /**
   * API ROUTES - Feature-based organization
   */

  // Authentication routes
  app.use("/api/auth", authRoutes);

  // User management routes
  app.use("/api/user", usersRoutes);

  // Asset routes (CRUD, types, spreadsheet)
  app.use("/api/assets", assetsRoutes);

  // Wallet routes
  app.use("/api/wallet", walletRoutes);

  // Import routes (Google Drive)
  app.use("/api/import", importRoutes);

  // Development/demo routes
  app.use("/api/dev", devRoutes);

  // Utility routes (health, stats, QR codes)
  app.use("/api", utilsRoutes);

  // Mount DID routes (uses didwebvh-ts verification)
  mountDIDRoutes(app, authenticateUser, turnkeyClient);

  /**
   * DID WEB HOSTING ROUTES - Catch-all patterns
   *
   * CRITICAL: These routes MUST be registered LAST to avoid conflicts with API routes
   * They use catch-all patterns (/:slug, /:userSlug) that would match any URL
   */

  // /.well-known/did/:slug - Legacy DID resolution endpoint
  app.get("/.well-known/did/:slug", async (req, res) => {
    try {
      const { slug } = req.params;

      // Try to resolve from storage
      const doc = await storage.getDIDDocument(slug);

      if (!doc) {
        return res.status(404).json({ error: 'DID not found' });
      }

      // Return DID document
      res.type("application/did+ld+json").send(JSON.stringify(doc.didDocument, null, 2));
    } catch (error) {
      console.error("Error resolving asset DID:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // /:userSlug/did.jsonl - DID log in JSONL format
  app.get("/:userSlug/did.jsonl", async (req, res) => {
    try {
      const { userSlug } = req.params;

      // First, check if file exists in public directory (preferred)
      const publicDir = path.join(process.cwd(), 'public');
      const filePath = path.join(publicDir, userSlug, "did.jsonl");

      if (fs.existsSync(filePath)) {
        // Serve the file directly from filesystem
        res.type("text/jsonl");
        return res.sendFile(filePath);
      }

      // Fallback: Look up user by DID slug in database
      const user = await storage.getUserByDidSlug(userSlug);

      if (!user?.didLog) {
        return res.status(404).json({ error: "DID log not found" });
      }

      // Convert log array to JSONL format
      const logArray = Array.isArray(user.didLog) ? user.didLog : [user.didLog];
      const jsonlContent = logArray.map((entry: any) => JSON.stringify(entry)).join('\n');

      // Set proper content type for JSONL
      res.type("application/jsonl").send(jsonlContent);
    } catch (error) {
      console.error("Error serving DID log:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // /:userSlug/resources/:hash - Serve published resource files
  app.get("/:userSlug/resources/:hash", async (req, res) => {
    try {
      const { userSlug, hash } = req.params;

      // Look up user to verify they exist
      const user = await storage.getUserByDidSlug(userSlug);
      if (!user || !user.did) {
        return res.status(404).json({ error: "User not found" });
      }

      // Look up all assets for this user to find the one with this resource
      const assets = await storage.getAssetsByUserId(user.did);

      // Find asset with matching resource hash
      let foundResource: any = null;

      for (const asset of assets) {
        const resources = (asset.metadata as any)?.resources;
        if (resources && Array.isArray(resources)) {
          const resource = resources.find((r: any) => {
            // Check if the hash matches (either the raw hash or multibase-encoded)
            return r.hash === hash || r.url?.includes(hash);
          });

          if (resource) {
            foundResource = resource;
            break;
          }
        }
      }

      if (!foundResource) {
        return res.status(404).json({ error: "Resource not found" });
      }

      // Serve the resource content
      const contentType = foundResource.contentType || 'application/octet-stream';
      const content = foundResource.content;

      if (!content) {
        return res.status(404).json({ error: "Resource content not available" });
      }

      // Set appropriate headers
      res.type(contentType);

      // Send the content
      if (typeof content === 'string') {
        res.send(content);
      } else if (Buffer.isBuffer(content)) {
        res.send(content);
      } else {
        res.json(content);
      }

      console.log(`✅ Served resource ${hash} for user ${userSlug}`);
    } catch (error) {
      console.error("Error serving resource:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // /:slug/did.jsonld - DID document resolution
  // This handles both user DIDs and asset DIDs
  app.get("/:slug/did.jsonld", async (req, res) => {
    try {
      const { slug } = req.params;

      // Check if this is an asset slug (format: asset-{id})
      if (slug.startsWith('asset-')) {
        // Extract asset ID from slug
        const assetIdPart = slug.replace('asset-', '');
        const assetId = `orig_${assetIdPart}`;

        // Look up asset
        const asset = await storage.getAsset(assetId);

        if (!asset?.didDocument) {
          return res.status(404).json({ error: "Asset DID document not found" });
        }

        // Return asset's DID document
        res.type("application/did+ld+json").send(JSON.stringify(asset.didDocument, null, 2));
        return;
      }

      // Otherwise, look up user by DID slug
      const user = await storage.getUserByDidSlug(slug);

      if (!user?.didDocument) {
        return res.status(404).json({ error: "DID not found" });
      }

      // Set proper content type for DID documents
      res.type("application/did+ld+json").send(JSON.stringify(user.didDocument, null, 2));
    } catch (error) {
      console.error("Error serving DID document:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
