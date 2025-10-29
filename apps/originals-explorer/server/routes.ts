import type { Express } from "express";
import { createServer, type Server } from "http";
import cookieParser from "cookie-parser";

// Import route modules
import authRoutes from "./routes/auth.routes";
import usersRoutes from "./routes/users.routes";
import didsRoutes from "./routes/dids.routes";
import assetsRoutes from "./routes/assets.routes";
import walletRoutes from "./routes/wallet.routes";
import utilsRoutes from "./routes/utils.routes";
import importRoutes from "./routes/import";

/**
 * Register all API routes
 *
 * Routes are organized by domain:
 * - /api/auth/* - Authentication (Turnkey email auth, Google OAuth, legacy OTP)
 * - /api/user/* - User management
 * - /api/did/* - DID operations (get, resolve, logs)
 * - /api/assets/* - Asset CRUD, migration, spreadsheet upload
 *   - /api/assets/asset-types/* - Asset type management (previously /api/asset-types/*)
 * - /api/wallet/* - Wallet connections
 * - /api/import/* - Google Drive imports
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

  // DID management routes (API endpoints only, not catch-all patterns)
  app.use("/api/did", didsRoutes);

  // Asset routes (CRUD, migration, types, spreadsheet)
  // Note: asset-types are now at /api/assets/asset-types (previously /api/asset-types)
  app.use("/api/assets", assetsRoutes);

  // Wallet routes
  app.use("/api/wallet", walletRoutes);

  // Import routes (Google Drive)
  app.use("/api/import", importRoutes);

  // Utility routes (health, stats, QR codes)
  app.use("/api", utilsRoutes);

  /**
   * DID WEB HOSTING ROUTES - Catch-all patterns
   *
   * CRITICAL: These routes MUST be registered LAST to avoid conflicts with API routes
   * They use catch-all patterns (/:slug, /:userSlug) that would match any URL
   *
   * According to DID:WebVH spec:
   * - Path-based DIDs: did:webvh:domain:path -> http://domain/path/did.jsonld
   * - Domain-only DIDs: did:webvh:domain -> http://domain/.well-known/did.jsonld
   */

  // Import storage for DID resolution
  const { storage } = await import("./storage");

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

      // Look up user by DID slug
      const user = await storage.getUserByDidSlug(userSlug);

      if (!user?.didLog) {
        return res.status(404).json({ error: "DID log not found" });
      }

      // Convert log array to JSONL format (one JSON object per line)
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
      // Use res.type().send() instead of res.json() to preserve the content type
      // Express's res.json() overwrites Content-Type to application/json
      res.type("application/did+ld+json").send(JSON.stringify(user.didDocument, null, 2));
    } catch (error) {
      console.error("Error serving DID document:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
