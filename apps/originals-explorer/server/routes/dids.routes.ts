import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { storage } from "../storage";

const router = Router();

/**
 * Get DID document for authenticated user
 */
router.get("/me", authenticateUser, async (req, res) => {
  try {
    const user = (req as any).user;
    const userData = await storage.getUserByDid(user.did);

    if (!userData?.didDocument) {
      return res.status(404).json({ error: "DID document not found" });
    }

    res.json({
      did: userData.did,
      didDocument: userData.didDocument,
      createdAt: userData.didCreatedAt,
    });
  } catch (error) {
    console.error("Error fetching DID document:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Get DID log for authenticated user (did.jsonl content)
 */
router.get("/me/log", authenticateUser, async (req, res) => {
  try {
    const user = (req as any).user;
    const userData = await storage.getUserByDid(user.did);

    if (!userData?.didLog) {
      return res.status(404).json({ error: "DID log not found" });
    }

    res.json({
      did: userData.did,
      log: userData.didLog,
    });
  } catch (error) {
    console.error("Error fetching DID log:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Resolve a DID:WebVH (public endpoint)
 */
router.get("/resolve/:did(*)", async (req, res) => {
  try {
    const did = req.params.did;

    // Validate DID format
    if (!did.startsWith('did:webvh:')) {
      return res.status(400).json({ error: "Invalid DID format. Must be did:webvh:..." });
    }

    // Try to find user by DID
    const user = await storage.getUserByDid(did);

    if (!user?.didDocument) {
      return res.status(404).json({ error: "DID not found" });
    }

    res.json({
      did: user.did,
      didDocument: user.didDocument,
      createdAt: user.didCreatedAt,
    });
  } catch (error) {
    console.error("Error resolving DID:", error);
    res.status(500).json({ error: "Failed to resolve DID" });
  }
});

/**
 * DID resolution endpoint for assets (/.well-known/did/:slug)
 * This resolves asset DIDs published to the web layer
 */
router.get("/.well-known/did/:slug", async (req, res) => {
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

/**
 * Serve DID log at path-based endpoint (did.jsonl)
 * According to DID:WebVH spec:
 * - Domain-only DID: did:webvh:example.com -> /.well-known/did.jsonl
 * - Path-based DID: did:webvh:example.com:alice -> /alice/did.jsonl (NO .well-known!)
 */
router.get("/:userSlug/did.jsonl", async (req, res) => {
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

/**
 * Serve DID document at path-based endpoint
 * IMPORTANT: These catch-all routes must be registered LAST to avoid conflicts
 *
 * According to DID:WebVH spec transformation:
 * - DID format: did:webvh:{url-encoded-domain}:{path-segments}
 * - The domain is URL-encoded (ports use %3A instead of :)
 * - Path-based DIDs resolve to: https://{domain}/{path-segments}/did.jsonld
 * - Domain-only DIDs would use: https://{domain}/.well-known/did.jsonld
 *
 * Example:
 * - DID: did:webvh:localhost%3A5000:alice
 * - Resolves to: http://localhost:5000/alice/did.jsonld
 * - Log at: http://localhost:5000/alice/did.jsonl
 */
router.get("/:slug/did.jsonld", async (req, res) => {
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

/**
 * Serve resources at /:userSlug/resources/:hash
 * This serves the actual resource files published to the web
 */
router.get("/:userSlug/resources/:hash", async (req, res) => {
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
    let foundAsset: any = null;

    for (const asset of assets) {
      const resources = (asset.metadata as any)?.resources;
      if (resources && Array.isArray(resources)) {
        const resource = resources.find((r: any) => {
          // Check if the hash matches (either the raw hash or multibase-encoded)
          return r.hash === hash || r.url?.includes(hash);
        });

        if (resource) {
          foundResource = resource;
          foundAsset = asset;
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

export default router;
