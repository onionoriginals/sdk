import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertAssetSchema, insertAssetTypeSchema, insertWalletConnectionSchema } from "@shared/schema";
import { z } from "zod";
import QRCode from "qrcode";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { Turnkey } from "@turnkey/sdk-server";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { originalsSdk } from "./originals";
import { createUserDIDWebVH, publishDIDDocument } from "./did-webvh-service";
import { OriginalsAsset } from "@originals/sdk";
import multer from "multer";
import { parse as csvParse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { VerifiableCredential } from "@originals/sdk";
import importRoutes from "./routes/import";

// Temporary in-memory storage for OTP codes
const otpStorage = new Map<string, { code: string; expires: number }>();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    if (allowedMimes.includes(file.mimetype) || file.originalname.match(/\.(csv|xlsx|xls)$/)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only CSV and XLSX files are allowed.'));
    }
  },
});

// Configure multer for image/media uploads
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'image/jpeg',
      'image/png', 
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'video/mp4',
      'video/webm',
      'audio/mpeg',
      'audio/wav',
      'application/pdf'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed types: images, videos, audio, PDF.'));
    }
  },
});

// Google OAuth2 client
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/auth/google/callback'
);

// Initialize Turnkey client with API key authentication
const stamper = new ApiKeyStamper({
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
});

const turnkeyClient = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  stamper,
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID!,
});

// Authentication middleware that uses did:webvh as primary identifier
const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authorizationHeader = req.headers.authorization;

    if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: "Missing or invalid authorization header" });
    }

    const token = authorizationHeader.substring(7);

    // Verify Turnkey session token
    // For now, we'll use a simple approach: the token contains the Turnkey sub-org ID
    // In production, you'd verify the token signature and claims
    let turnkeyUserId: string;

    try {
      // Parse the token to extract user info
      // This is a simplified version - in production, properly verify JWT or session token
      const tokenPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      turnkeyUserId = tokenPayload.sub || tokenPayload.userId;

      if (!turnkeyUserId) {
        throw new Error('No user ID in token');
      }
    } catch (err) {
      console.error("Token parsing error:", err);
      return res.status(401).json({ error: "Invalid token format" });
    }

    // Check if user already exists by Turnkey ID
    let user = await storage.getUserByTurnkeyId(turnkeyUserId);

    // If user doesn't exist, create DID:WebVH and user record
    if (!user) {
      console.log(`Creating DID:WebVH for new user ${turnkeyUserId}...`);
      const didData = await createUserDIDWebVH(turnkeyUserId, turnkeyClient);

      // Create user with DID as primary identifier
      user = await storage.createUserWithDid(turnkeyUserId, didData.did, didData);
    }

    // Add user info to request with database ID as primary identifier
    (req as any).user = {
      id: user.id, // Primary identifier is the database UUID (for foreign keys)
      turnkeyUserId: turnkeyUserId, // Turnkey sub-org ID for key operations
      did: user.did, // DID for display/lookup
      authToken: token, // Store token for future use
    };

    next();
  } catch (error) {
    console.error("Authentication error:", error);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

export async function registerRoutes(app: Express): Promise<Server> {
  // Mount Google Drive import routes
  app.use("/api/import", importRoutes);

  // Healthcheck for Originals SDK integration
  app.get("/api/originals/health", async (_req, res) => {
    try {
      // Accessing the instance verifies import/initialization without performing network operations
      void originalsSdk;
      res.json({ initialized: true });
    } catch (_e) {
      res.status(500).json({ initialized: false });
    }
  });
  // Get authenticated user
  app.get("/api/user", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      res.json({
        id: user.id, // This is now the did:webvh
        did: user.did,
        turnkeyUserId: user.turnkeyUserId, // Keep for reference
      });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get user's DID:WebVH (automatically created during authentication)
  app.post("/api/user/ensure-did", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      
      // DID is automatically created during authentication, so just return it
      return res.json({ 
        did: user.did,
        created: false // Always false since it's created during auth
      });
    } catch (error) {
      console.error("Error getting user DID:", error);
      return res.status(500).json({ 
        error: "Failed to get DID",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // DID Management API Endpoints
  
  // Get DID document for authenticated user
  app.get("/api/did/me", authenticateUser, async (req, res) => {
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

  // Get DID log for authenticated user (did.jsonl content)
  app.get("/api/did/me/log", authenticateUser, async (req, res) => {
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

  // Resolve a DID:WebVH (public endpoint)
  app.get("/api/did/resolve/:did(*)", async (req, res) => {
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

  // Advanced: Create DID with SDK-managed keys (alternative to Privy)
  // This endpoint is for advanced users who want full control over key management
  app.post("/api/did/create-with-sdk", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      
      // Check if user already has a DID
      const existingUser = await storage.getUserByDid(user.did);
      if (existingUser?.did) {
        return res.status(400).json({ 
          error: "User already has a DID",
          did: existingUser.did 
        });
      }

      // Import the WebVH integration service
      const { webvhService } = await import('./webvh-integration');
      
      // Create DID using SDK
      const result = await webvhService.createDIDWithSDK(user.privyId);
      
      // Update user with SDK-created DID
      await storage.updateUser(user.privyId, {
        did: result.did,
        didDocument: result.didDocument as any,
        didLog: result.log as any,
        didSlug: user.privyId.replace(/^did:privy:/, ''),
        didCreatedAt: new Date(),
      });
      
      res.status(201).json({
        success: true,
        did: result.did,
        didDocument: result.didDocument,
        logPath: result.logPath,
        message: "DID created with SDK-managed keys. Keep your private key secure!",
        keyPair: {
          publicKey: result.keyPair.publicKey,
          // Never expose private key in response for production
          // privateKey: result.keyPair.privateKey,
        },
      });
    } catch (error) {
      console.error("Error creating DID with SDK:", error);
      res.status(500).json({ 
        error: "Failed to create DID",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Assets routes
  app.get("/api/assets", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      const { layer } = req.query;
      
      // Use the authenticated user's DID as the user identifier
      // Support optional layer filtering
      const options = layer ? { layer: layer as any } : undefined;
      const assets = await storage.getAssetsByUserId(user.id, options);
      res.json(assets);
    } catch (error) {
      console.error("Error fetching assets:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/assets/:id", async (req, res) => {
    try {
      const asset = await storage.getAsset(req.params.id);
      if (!asset) {
        return res.status(404).json({ error: "Asset not found" });
      }
      res.json(asset);
    } catch (error) {
      console.error("Error fetching asset:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/assets", async (req, res) => {
    try {
      const validatedData = insertAssetSchema.parse(req.body);
      const asset = await storage.createAsset(validatedData);
      res.status(201).json(asset);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation error", details: error.errors });
      }
      console.error("Error creating asset:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.put("/api/assets/:id", async (req, res) => {
    try {
      const updates = req.body;
      const asset = await storage.updateAsset(req.params.id, updates);
      if (!asset) {
        return res.status(404).json({ error: "Asset not found" });
      }
      res.json(asset);
    } catch (error) {
      console.error("Error updating asset:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Helper function to validate URLs against SSRF attacks
  const isUrlSafe = (urlString: string): { safe: boolean; error?: string } => {
    try {
      const url = new URL(urlString);
      
      // Only allow http and https schemes
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { safe: false, error: 'Only HTTP and HTTPS URLs are allowed' };
      }
      
      // Block localhost and loopback addresses
      const hostname = url.hostname.toLowerCase();
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
        return { safe: false, error: 'Localhost URLs are not allowed' };
      }
      
      // Block private IP ranges (simplified check)
      // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (link-local)
      const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
      const ipMatch = hostname.match(ipv4Regex);
      if (ipMatch) {
        const [, a, b, c, d] = ipMatch.map(Number);
        
        // Check for private IP ranges
        if (a === 10 || // 10.0.0.0/8
            (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
            (a === 192 && b === 168) || // 192.168.0.0/16
            (a === 169 && b === 254)) { // 169.254.0.0/16 (cloud metadata)
          return { safe: false, error: 'Private IP addresses are not allowed' };
        }
      }
      
      // Block common localhost variations
      if (hostname.endsWith('.local') || hostname.endsWith('.localhost')) {
        return { safe: false, error: 'Local domain names are not allowed' };
      }
      
      return { safe: true };
    } catch (error) {
      return { safe: false, error: 'Invalid URL format' };
    }
  };

  // Create asset with DID integration (uses Originals SDK)
  app.post("/api/assets/create-with-did", authenticateUser, mediaUpload.single('mediaFile'), async (req, res) => {
    try {
      const user = (req as any).user;
      
      // Parse request body (form data)
      const { title, description, category, tags, mediaUrl, metadata } = req.body;
      
      // Validate that we have either a file or URL
      if (!req.file && !mediaUrl) {
        return res.status(400).json({ 
          error: "No media provided. Please provide either a mediaFile upload or mediaUrl." 
        });
      }

      // Validate title
      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ 
          error: "Title is required and must be a non-empty string." 
        });
      }

      let mediaFileHash: string; // Hash of the actual media file (for reference)
      let fileBuffer: Buffer;
      let contentType: string;
      let actualMediaUrl: string | null = null;

      // Step 1: Hash Media Content (for reference/verification of original file)
      if (req.file) {
        // File uploaded
        fileBuffer = req.file.buffer;
        mediaFileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        contentType = req.file.mimetype;
        
        // For uploaded files, we could store them and generate a URL
        // For now, we'll use data URI
        const base64Data = fileBuffer.toString('base64');
        actualMediaUrl = `data:${contentType};base64,${base64Data}`;
      } else if (mediaUrl) {
        // URL provided - validate and fetch
        // Validate URL to prevent SSRF attacks
        const urlValidation = isUrlSafe(mediaUrl);
        if (!urlValidation.safe) {
          return res.status(400).json({ 
            error: "Invalid or unsafe URL",
            details: urlValidation.error 
          });
        }
        
        try {
          // Fetch with timeout and size limit to prevent DoS
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
          
          const response = await fetch(mediaUrl, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Originals-SDK/1.0' // Identify ourselves
            }
          });
          
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            return res.status(400).json({ 
              error: `Failed to fetch media from URL: ${response.statusText}` 
            });
          }
          
          // Check content length before downloading
          const contentLength = response.headers.get('content-length');
          const maxSize = 10 * 1024 * 1024; // 10MB limit (same as file upload)
          
          if (contentLength && parseInt(contentLength) > maxSize) {
            return res.status(413).json({ 
              error: "Media file too large",
              details: `Maximum size is 10MB, URL content is ${Math.round(parseInt(contentLength) / 1024 / 1024)}MB` 
            });
          }
          
          // Stream the response with size limit
          const chunks: Buffer[] = [];
          let downloadedSize = 0;
          
          if (response.body) {
            const reader = response.body.getReader();
            
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                downloadedSize += value.length;
                if (downloadedSize > maxSize) {
                  reader.cancel();
                  return res.status(413).json({ 
                    error: "Media file too large",
                    details: "Maximum size is 10MB" 
                  });
                }
                
                chunks.push(Buffer.from(value));
              }
            } finally {
              reader.releaseLock();
            }
          }
          
          fileBuffer = Buffer.concat(chunks);
          mediaFileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
          contentType = response.headers.get('content-type') || 'application/octet-stream';
          actualMediaUrl = mediaUrl;
        } catch (fetchError: any) {
          if (fetchError.name === 'AbortError') {
            return res.status(408).json({ 
              error: "Request timeout",
              details: "Failed to fetch media within 30 seconds" 
            });
          }
          return res.status(400).json({ 
            error: "Failed to fetch media from URL",
            details: fetchError.message 
          });
        }
      } else {
        return res.status(400).json({ error: "No media provided" });
      }

      // Parse tags if provided
      let parsedTags: string[] = [];
      if (tags) {
        try {
          parsedTags = typeof tags === 'string' 
            ? JSON.parse(tags) 
            : Array.isArray(tags) 
            ? tags 
            : [];
        } catch {
          parsedTags = typeof tags === 'string' ? [tags] : [];
        }
      }

      // Parse metadata if provided
      let parsedMetadata: Record<string, any> = {};
      if (metadata) {
        try {
          parsedMetadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
        } catch {
          parsedMetadata = {};
        }
      }

      // Step 2: Create AssetResource Array
      // For binary files, we store JSON metadata in the DID resource
      // The actual media content is referenced via URL or data URI
      const assetMetadata = {
        title: title,
        description: description || '',
        category: category || '',
        tags: parsedTags,
        mediaType: contentType, // Original media MIME type
        mediaFileHash: mediaFileHash, // Hash of the actual media file (for integrity verification)
        ...parsedMetadata
      };
      
      const metadataString = JSON.stringify(assetMetadata);
      const metadataHash = crypto.createHash('sha256').update(metadataString).digest('hex');
      
      // Resource represents the metadata, not the media file itself
      const resources = [{
        id: `resource-${Date.now()}`,
        type: 'AssetMetadata', // Type matches content: this is metadata, not the media file
        contentType: 'application/json', // Content is JSON metadata
        hash: metadataHash, // Hash of the metadata JSON string
        content: metadataString, // JSON metadata as string
        url: actualMediaUrl || undefined // Reference to actual media file
      }];

      // Step 3: Call SDK to Create Asset with DID
      console.log(`Creating asset with Originals SDK for user ${user.id}...`);
      let originalsAsset;
      try {
        originalsAsset = await originalsSdk.lifecycle.createAsset(resources);
        console.log(`✅ Created did:peer: ${originalsAsset.id}`);
      } catch (sdkError: any) {
        console.error('SDK creation error:', sdkError);
        return res.status(500).json({ 
          error: "Failed to create asset with Originals SDK",
          details: sdkError.message 
        });
      }

      // Step 4: Store in Database
      const assetData = {
        userId: user.id,
        title: title,
        description: description || null,
        category: category || null,
        tags: parsedTags,
        mediaUrl: actualMediaUrl,
        metadata: {
          ...parsedMetadata,
          mediaType: contentType, // Original media MIME type
          mediaFileHash: mediaFileHash, // Hash of the actual media file
          metadataHash: metadataHash, // Hash of the DID resource (metadata JSON)
          resourceId: resources[0].id,
          resources: resources // Store resources for later reconstruction
        },
        
        // SDK-generated fields
        currentLayer: 'did:peer' as const,
        didPeer: originalsAsset.id,
        didDocument: originalsAsset.did as any,
        credentials: originalsAsset.credentials as any,
        provenance: originalsAsset.getProvenance() as any,
        
        status: 'completed',
        assetType: 'original'
      };

      let asset;
      try {
        const validatedAsset = insertAssetSchema.parse(assetData);
        asset = await storage.createAsset(validatedAsset);
        console.log(`✅ Stored asset in database: ${asset.id}`);
      } catch (dbError: any) {
        console.error('Database storage error:', dbError);
        return res.status(500).json({ 
          error: "Failed to store asset in database",
          details: dbError.message 
        });
      }

      // Step 5: Return Complete Response
      res.status(201).json({
        asset: {
          id: asset.id,
          title: asset.title,
          description: asset.description,
          category: asset.category,
          tags: asset.tags,
          mediaUrl: asset.mediaUrl,
          currentLayer: asset.currentLayer,
          didPeer: asset.didPeer,
          didDocument: asset.didDocument,
          credentials: asset.credentials,
          provenance: asset.provenance,
          status: asset.status,
          assetType: asset.assetType,
          createdAt: asset.createdAt,
          metadata: asset.metadata
        },
        originalsAsset: {
          did: originalsAsset.id,
          resources: originalsAsset.resources,
          provenance: originalsAsset.getProvenance()
        }
      });

    } catch (error: any) {
      console.error("Error creating asset with DID:", error);
      
      // Handle specific error types
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          error: "Validation error", 
          details: error.errors 
        });
      }
      
      if (error.message && error.message.includes('file type')) {
        return res.status(400).json({ 
          error: error.message 
        });
      }
      
      res.status(500).json({ 
        error: "Internal server error",
        details: error.message 
      });
    }
  });

  // Generate random did:peer asset (for testing/demo)
  app.post("/api/assets/generate-random", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      
      // Random data generators
      const adjectives = ['Quantum', 'Digital', 'Cosmic', 'Ethereal', 'Neon', 'Crystal', 'Cybernetic', 'Holographic', 'Prismatic', 'Luminous'];
      const nouns = ['Artifact', 'Essence', 'Fragment', 'Relic', 'Token', 'Sigil', 'Catalyst', 'Nexus', 'Portal', 'Cipher'];
      const categories = ['art', 'collectible', 'music', 'video', 'document'];
      
      const randomAdjective = adjectives[Math.floor(Math.random() * adjectives.length)];
      const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
      const randomCategory = categories[Math.floor(Math.random() * categories.length)];
      const randomNumber = Math.floor(Math.random() * 9999);
      
      const title = `${randomAdjective} ${randomNoun} #${randomNumber}`;
      const description = `A randomly generated digital asset created at ${new Date().toISOString()}`;
      
      // Generate random content (JSON data)
      const randomContent = JSON.stringify({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        attributes: {
          rarity: ['common', 'uncommon', 'rare', 'epic', 'legendary'][Math.floor(Math.random() * 5)],
          power: Math.floor(Math.random() * 100),
          element: ['fire', 'water', 'earth', 'air', 'void'][Math.floor(Math.random() * 5)],
        },
        metadata: {
          generator: 'Random Asset Generator v1.0',
          network: process.env.NETWORK || 'regtest'
        }
      }, null, 2);
      
      // Hash the content
      const contentHash = crypto.createHash('sha256').update(randomContent).digest('hex');
      
      // Create resources for the SDK
      const resources = [
        {
          id: crypto.randomUUID(),
          type: 'data',
          contentType: 'application/json',
          hash: contentHash,
          content: randomContent,
          size: Buffer.byteLength(randomContent)
        }
      ];
      
      // Create asset using SDK
      const originalsAsset = await originalsSdk.lifecycle.createAsset(resources);
      
      // Store in database
      const dbAsset = await storage.createAsset({
        userId: user.id,
        title,
        description,
        category: randomCategory,
        tags: ['random', 'generated', 'demo'],
        mediaUrl: null,
        metadata: {
          resources,
          generatedAt: new Date().toISOString(),
          generator: 'random'
        },
        currentLayer: 'did:peer',
        didPeer: originalsAsset.id,
        didWebvh: undefined,
        didBtco: undefined,
        didDocument: originalsAsset.did,
        credentials: originalsAsset.credentials,
        provenance: originalsAsset.getProvenance(),
        status: 'completed',
        assetType: 'original'
      });
      
      console.log(`✅ Generated random asset: ${dbAsset.id} (${title})`);
      
      res.json({
        success: true,
        message: 'Random asset generated successfully',
        asset: dbAsset,
        originalsAsset: {
          did: originalsAsset.id,
          resources: originalsAsset.resources,
          provenance: originalsAsset.getProvenance()
        }
      });
      
    } catch (error: any) {
      console.error("Error generating random asset:", error);
      res.status(500).json({ 
        error: "Failed to generate random asset",
        details: error.message 
      });
    }
  });

  // Publish asset to web (did:peer -> did:webvh)
  app.post("/api/assets/:id/publish-to-web", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      const assetId = req.params.id;
      
      // Get asset from database
      const asset = await storage.getAsset(assetId);
      
      if (!asset) {
        return res.status(404).json({ error: 'Asset not found' });
      }
      
      // Check ownership
      if (asset.userId !== user.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      
      // Check current layer
      if (asset.currentLayer !== 'did:peer') {
        return res.status(400).json({ 
          error: `Asset is already in ${asset.currentLayer} layer. Can only publish from did:peer.`
        });
      }
      
      // Verify asset has did:peer identifier
      if (!asset.didPeer) {
        return res.status(400).json({ 
          error: 'Asset missing did:peer identifier. Cannot publish.' 
        });
      }
      
      // Verify user has a did:webvh
      if (!user.did || !user.did.startsWith('did:webvh:')) {
        return res.status(400).json({ 
          error: 'User missing did:webvh identifier. Cannot publish.' 
        });
      }
      
      // Reconstruct OriginalsAsset from database
      const resources = (asset.metadata as any)?.resources;
      
      if (!resources || !Array.isArray(resources) || resources.length === 0) {
        return res.status(400).json({ 
          error: 'Asset missing resources data. Cannot reconstruct for publishing.' 
        });
      }
      
      const originalsAsset = new OriginalsAsset(
        resources,
        asset.didDocument as any,
        (asset.credentials as any) || []
      );
      
      // Get user's Privy signer for signing credentials
      let publisherSigner;
      try {
        const userData = await storage.getUserByDid(user.did);
        if (!userData || !userData.updateWalletId) {
          throw new Error('User missing update wallet for signing');
        }
        
        // Import Privy signer creation
        const { createPrivySigner } = await import('./privy-signer');
        
        // Create signer using user's update wallet
        const verificationMethodId = `${user.did}#key-0`;
        publisherSigner = await createPrivySigner(
          user.privyId,
          userData.updateWalletId,
          privyClient,
          verificationMethodId,
          req.headers.authorization?.replace('Bearer ', '') || ''
        );
      } catch (signerError: any) {
        console.error('Failed to create signer:', signerError);
        return res.status(500).json({
          error: 'Failed to create credential signer',
          details: signerError.message
        });
      }
      
      // Publish to web using SDK with publisher's DID and signer
      let publishedAsset: OriginalsAsset;
      try {
        publishedAsset = await originalsSdk.lifecycle.publishToWeb(
          originalsAsset,
          publisherSigner // Use signer instead of domain
        );
        console.log('Published to web:', publishedAsset.id, 'by', user.did);
      } catch (sdkError: any) {
        console.error('Publish error:', sdkError);
        return res.status(500).json({ 
          error: 'Failed to publish to web',
          details: sdkError.message 
        });
      }
      
      // Extract did:webvh from bindings (should be the user's DID)
      const bindings = (publishedAsset as any).bindings || {};
      const didWebvh = bindings['did:webvh'];
      
      if (!didWebvh) {
        return res.status(500).json({ 
          error: 'Failed to bind asset to did:webvh' 
        });
      }
      
      // Verify it matches the user's DID
      if (didWebvh !== user.did) {
        console.warn(`Warning: Published asset bound to ${didWebvh} but user DID is ${user.did}`);
      }
      
      // Create a proper did:webvh document by updating the id field
      const didWebvhDocument = {
        ...publishedAsset.did,
        id: didWebvh
      };
      
      // Store original values for potential rollback
      const originalDidDocument = asset.didDocument;
      const originalCredentials = asset.credentials;
      const originalProvenance = asset.provenance;
      
      // Update database with new layer and did:webvh
      const updatedAsset = await storage.updateAsset(assetId, {
        currentLayer: 'did:webvh',
        didWebvh: didWebvh,
        didDocument: didWebvhDocument as any,
        credentials: publishedAsset.credentials as any,
        provenance: publishedAsset.getProvenance() as any,
        updatedAt: new Date()
      });
      
      if (!updatedAsset) {
        return res.status(500).json({ 
          error: 'Failed to update asset in database' 
        });
      }
      
      // Issue ownership credential from user's DID to asset's DID
      let ownershipCredential;
      try {
        // Get full user data to access their wallets
        const userData = await storage.getUserByDid(user.did);
        
        if (!userData || !userData.assertionWalletId || !userData.assertionKeyPublic) {
          throw new Error('User missing assertion key for signing');
        }
        
        // Create ownership credential
        const credentialSubject = {
          id: didWebvh, // The asset's DID
          owner: user.did, // The user's DID
          assetType: 'OriginalsAsset',
          title: asset.title,
          publishedAt: new Date().toISOString(),
          resources: publishedAsset.resources.map(r => ({
            id: r.id,
            hash: r.hash,
            contentType: r.contentType
          }))
        };
        
        const unsignedCredential = await originalsSdk.credentials.createResourceCredential(
          'ResourceCreated',
          credentialSubject,
          user.did // Issued by the user
        );
        
        // Import Privy signer utilities
        const { createPrivySigner } = await import('./privy-signer');
        
        // Get verification method ID for the user's assertion key
        const verificationMethodId = `${user.did}#assertion-key`;
        
        // Create a signer for the user's assertion wallet
        const userSigner = await createPrivySigner(
          user.privyId,
          userData.assertionWalletId,
          privyClient,
          verificationMethodId,
          user.authToken
        );
        
        // Use SDK's external signer support to sign the credential
        ownershipCredential = await originalsSdk.credentials.signCredentialWithExternalSigner(
          unsignedCredential,
          userSigner
        );
        
        console.log(`✅ Ownership credential signed by user ${user.did} for asset ${didWebvh}`);
      } catch (credError: any) {
        console.error('Failed to issue ownership credential:', credError);
        // Don't fail the whole operation, but log the error
        console.warn('Asset published but ownership credential not issued');
      }
      
      // Publish DID document to make it publicly accessible
      try {
        await publishDIDDocument({
          did: didWebvh,
          didDocument: didWebvhDocument,
          didLog: publishedAsset.getProvenance()
        });
      } catch (publishError: any) {
        console.error('Failed to publish DID document:', publishError);
        // Rollback database changes - restore all original values
        await storage.updateAsset(assetId, {
          currentLayer: 'did:peer',
          didWebvh: null,
          didDocument: originalDidDocument,
          credentials: originalCredentials,
          provenance: originalProvenance,
        });
        return res.status(500).json({ 
          error: 'Failed to publish DID document',
          details: publishError.message 
        });
      }
      
      // Extract domain and path from DID for HTTP URLs
      // Format with SCID: did:webvh:SCID:domain:path1:path2...
      // Format without SCID: did:webvh:domain:path1:path2...
      // HTTP URL should be: http://domain/path1/path2/... (SCID stripped if present)
      const didParts = didWebvh.split(':');
      if (didParts.length < 4) {
        console.error('Invalid did:webvh format:', didWebvh);
        return res.status(500).json({ 
          error: 'Generated invalid did:webvh identifier' 
        });
      }
      
      // Detect if SCID is present (didwebvh-ts format)
      // SCID is a multibase hash, typically starts with 'Q' or 'z' and is long
      // Domain typically contains dots or is 'localhost'
      let domainIndex: number;
      let pathStartIndex: number;
      
      const part2 = didParts[2];
      const part3 = didParts[3];
      
      // Check if part2 looks like an SCID (multibase hash) vs a domain
      const isSCIDPresent = part2.length > 20 && /^[Qz]/.test(part2) && !part2.includes('.');
      
      if (isSCIDPresent && didParts.length >= 5) {
        // Format: did:webvh:SCID:domain:path...
        // didParts: ['did', 'webvh', 'SCID', 'domain', 'path1', 'path2', ...]
        domainIndex = 3;
        pathStartIndex = 4;
      } else {
        // Format: did:webvh:domain:path...
        // didParts: ['did', 'webvh', 'domain', 'path1', 'path2', ...]
        domainIndex = 2;
        pathStartIndex = 3;
      }
      
      const didDomainEncoded = didParts[domainIndex];
      const didDomain = decodeURIComponent(didDomainEncoded);
      
      // Get all path segments after domain
      const userPathSegments = didParts.slice(pathStartIndex);
      const userPath = userPathSegments.join('/');
      
      // Use request protocol or environment variable
      const protocol = process.env.APP_PROTOCOL || req.protocol || 'http';
      
      // Return response with DID-based resource URLs
      res.json({
        asset: updatedAsset,
        originalsAsset: {
          did: publishedAsset.id,
          previousDid: asset.didPeer,
          resources: publishedAsset.resources.map(r => {
            // Extract multibase hash from DID-based URL
            // Format: did:webvh:SCID:domain:path.../resources/multibase-hash
            const didUrl = r.url || '';
            const hashMatch = didUrl.match(/\/resources\/(.+)$/);
            const multibaseHash = hashMatch ? hashMatch[1] : r.hash;
            
            return {
              ...r,
              // DID-based URL (primary) - includes SCID
              url: r.url,
              // HTTP URL (for browser access) - SCID stripped, domain decoded
              httpUrl: `${protocol}://${didDomain}/${userPath}/resources/${multibaseHash}`
            };
          }),
          provenance: publishedAsset.getProvenance()
        },
        resolverUrl: `${protocol}://${didDomain}/${userPath}/did.jsonld`,
        ownershipCredential: ownershipCredential || null
      });
      
    } catch (error: any) {
      console.error("Error publishing asset to web:", error);
      
      if (error.message && error.message.includes('Invalid migration')) {
        return res.status(400).json({ 
          error: error.message 
        });
      }
      
      res.status(500).json({ 
        error: "Internal server error",
        details: error.message 
      });
    }
  });

  // Asset Types routes
  app.get("/api/asset-types", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      const assetTypes = await storage.getAssetTypesByUserId(user.id);
      res.json(assetTypes);
    } catch (error) {
      console.error("Error fetching asset types:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/asset-types", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      const validatedData = insertAssetTypeSchema.parse({
        ...req.body,
        userId: user.id, // Use did:webvh as user ID
      });
      const assetType = await storage.createAssetType(validatedData);
      res.status(201).json(assetType);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation error", details: error.errors });
      }
      console.error("Error creating asset type:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Spreadsheet upload route
  app.post("/api/assets/upload-spreadsheet", authenticateUser, upload.single('file'), async (req, res) => {
    try {
      const user = (req as any).user;
      
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const fileBuffer = req.file.buffer;
      const fileType = req.file.mimetype;
      let rows: any[] = [];

      // Parse spreadsheet based on file type
      if (fileType === 'text/csv' || req.file.originalname.endsWith('.csv')) {
        rows = csvParse(fileBuffer, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        });
      } else {
        // Parse XLSX
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        rows = XLSX.utils.sheet_to_json(worksheet);
      }

      if (rows.length === 0) {
        return res.status(400).json({ error: "Spreadsheet is empty" });
      }

      // Process each row and create assets
      const createdAssets = [];
      const errors: Array<{ row: number; error: string }> = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          // No required fields - let users upload whatever they want
          // The system will handle missing data gracefully

          // Parse tags if provided
          let tags: string[] = [];
          if (row.tags) {
            tags = typeof row.tags === 'string' 
              ? row.tags.split(',').map((t: string) => t.trim())
              : row.tags;
          }

          // Extract custom properties (any columns not in standard fields)
          const standardFields = ['title', 'description', 'category', 'tags', 'mediaUrl', 'status', 'type'];
          const customProperties: Record<string, any> = {};
          for (const [key, value] of Object.entries(row)) {
            if (!standardFields.includes(key)) {
              customProperties[key] = value;
            }
          }

          // Create asset data with sensible defaults
          // Generate a meaningful title if none provided
          let generatedTitle = row.title;
          if (!generatedTitle) {
            // Try to create a meaningful title from available data
            if (row.type) {
              generatedTitle = `${row.type} ${i + 1}`;
            } else if (row.category) {
              generatedTitle = `${row.category} Asset ${i + 1}`;
            } else if (Object.keys(customProperties).length > 0) {
              const firstProp = Object.entries(customProperties)[0];
              generatedTitle = `${firstProp[1]} (Row ${i + 2})`;
            } else {
              generatedTitle = `Untitled Asset ${i + 1}`;
            }
          }

          const assetData = {
            title: generatedTitle,
            description: row.description || "",
            category: row.category || "", // Default to empty string if not provided
            tags,
            mediaUrl: row.mediaUrl || "",
            metadata: {
              assetTypeName: row.type || "General", // Use 'type' column for asset type name
              customProperties,
              uploadedViaSpreadsheet: true,
              originalRowNumber: i + 2, // Track which row this came from
            },
            userId: user.id, // Use did:webvh as user ID
            assetType: "original", // Always "original" for spreadsheet uploads
            status: row.status || "draft",
            credentials: [] as VerifiableCredential[],
          };

          // Create did:peer for the asset using Originals SDK
          try {
            // Create a resource representation for the asset
            const assetContent = JSON.stringify({
              title: row.title,
              description: row.description || "",
              category: row.category,
              tags,
              customProperties,
            });
            
            const assetBuffer = Buffer.from(assetContent, 'utf-8');
            const assetHash = crypto.createHash('sha256').update(assetBuffer).digest('hex');
            
            const resources = [{
              id: `asset-${Date.now()}-${i}`,
              type: 'AssetMetadata',
              contentType: 'application/json',
              hash: assetHash,
              content: assetContent,
            }];

            // Create the asset with did:peer using the SDK
            const originalsAsset = await originalsSdk.lifecycle.createAsset(resources);
            
            // Store the DID document in credentials
            // assetData.credentials = [{
            //   didDocument: originalsAsset.did,
            //   did: originalsAsset.id,
            // }];

            console.log(`Created did:peer for asset "${row.title}": ${originalsAsset.id}`);
          } catch (didError: any) {
            console.error(`Failed to create did:peer for row ${i + 2}:`, didError);
            // Continue with asset creation even if DID creation fails
            // This allows partial success
          }

          // Validate and create asset
          const validatedAsset = insertAssetSchema.parse(assetData);
          const asset = await storage.createAsset(validatedAsset);
          createdAssets.push(asset);

        } catch (error: any) {
          errors.push({
            row: i + 2,
            error: error.message || "Failed to create asset"
          });
        }
      }

      // Auto-create asset type if it doesn't exist
      if (createdAssets.length > 0) {
        // Find the first successfully created asset to get the asset type info
        const firstAsset = createdAssets[0];
        const assetTypeName = (firstAsset.metadata as any)?.assetTypeName;
        
        if (assetTypeName) {
          const existingTypes = await storage.getAssetTypesByUserId(user.id);
          const typeExists = existingTypes.some(t => t.name === assetTypeName);

          if (!typeExists) {
            // Use the custom properties from the first created asset
            const customProperties = (firstAsset.metadata as any)?.customProperties || {};
            const properties = Object.keys(customProperties).map((key, index) => ({
              id: `prop_${index}`,
              key,
              label: key.charAt(0).toUpperCase() + key.slice(1),
              type: "text" as const,
              required: false,
            }));

            await storage.createAssetType({
              userId: user.id, // Use did:webvh as user ID
              name: assetTypeName,
              description: `Auto-created from spreadsheet upload`,
              properties,
            });
          }
        }
      }

      res.status(201).json({
        success: true,
        created: createdAssets.length,
        failed: errors.length,
        assets: createdAssets,
        errors: errors.length > 0 ? errors : undefined,
      });

    } catch (error: any) {
      console.error("Error processing spreadsheet:", error);
      res.status(500).json({ error: error.message || "Failed to process spreadsheet" });
    }
  });

  // Wallet connection routes
  app.post("/api/wallet/connect", async (req, res) => {
    try {
      const validatedData = insertWalletConnectionSchema.parse(req.body);
      const connection = await storage.createWalletConnection(validatedData);
      res.status(201).json(connection);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation error", details: error.errors });
      }
      console.error("Error connecting wallet:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create both Bitcoin and Stellar wallets automatically in one call
  app.post("/api/wallets/create-both", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      if (!user?.id) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Read policy IDs from environment (may be required by Privy)
      const rawPolicyIds = process.env.PRIVY_EMBEDDED_WALLET_POLICY_IDS || "";
      const policyIds = rawPolicyIds
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      
      // Use Privy to create both Bitcoin and Stellar wallets using individual calls
      // Privy manages all keys - we never see or store private keys
      // The API will automatically handle HD wallet indexing
      let btcWallet = await privyClient.wallets().create({
        owner: {
          user_id: user.privyId, // Use Privy ID for wallet operations
        },
        chain_type: "bitcoin-segwit",
        policy_ids: policyIds.length > 0 ? policyIds : [],
      });
      console.log("Bitcoin wallet created:", btcWallet);
      
      let stellarWallet = await privyClient.wallets().create({
        owner: {
          user_id: user.privyId, // Use Privy ID for wallet operations
        },
        chain_type: "stellar",
        policy_ids: policyIds.length > 0 ? policyIds : [],
      });
      console.log("Stellar wallet created:", stellarWallet);

      // Fetch updated user to get all wallets (since there could be multiple)
      const updatedUser = await privyClient.users()._get(user.privyId);
      const allWallets = updatedUser.linked_accounts?.filter((a: any) => a.type === 'wallet') || [];

      console.log("Bitcoin and Stellar wallets created. User now has", allWallets.length, "wallets");

      // Privy returns the wallet info with public keys
      // Private keys are managed entirely by Privy's infrastructure
      return res.status(201).json({
        success: true,
        message: "Bitcoin and Stellar wallets created and managed by Privy",
        userId: user.privyId, // Use Privy ID for wallet operations
        wallets: allWallets,
        btcWallet,
        stellarWallet,
      });
    } catch (error: any) {
      console.error("Error creating Bitcoin and Stellar wallets:", error);
      return res.status(500).json({ error: error.message || "Failed to create wallets" });
    }
  });

  // Create a Privy Bitcoin wallet for the authenticated user
  // Create Stellar wallet (uses ED25519 for signing)
  // Automatically handles being first wallet or additional wallet
  app.post("/api/wallets/stellar", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      if (!user?.id) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Get user to check existing wallets
      const privyUser = await privyClient.users()._get(user.privyId);
      
      // Read policy IDs from environment (may be required by Privy)
      const rawPolicyIds = process.env.PRIVY_EMBEDDED_WALLET_POLICY_IDS || "";
      const policyIds = rawPolicyIds
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      
      // Use Privy to create a Stellar wallet (ED25519-based)
      // Privy manages all keys - we never see or store private keys
      // The API will automatically handle HD wallet indexing
      const result = await privyClient.wallets().create({
        owner: {
          user_id: user.privyId, // Use Privy ID for wallet operations
        },
        chain_type: "stellar",
        policy_ids: policyIds.length > 0 ? policyIds : [],
      });

      // Privy returns the wallet info with public key
      // Private key is managed entirely by Privy's infrastructure
      return res.status(201).json({
        success: true,
        message: "Stellar wallet created with ED25519 keys managed by Privy",
        userId: user.privyId, // Use Privy ID for wallet operations
        wallet: result,
      });
    } catch (error: any) {
      console.error("Error creating Stellar wallet:", error);
      return res.status(500).json({ error: error.message || "Failed to create Stellar wallet" });
    }
  });

  // Create Bitcoin wallet
  // Automatically handles being first wallet or additional wallet
  app.post("/api/wallets/bitcoin", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      if (!user?.id) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Get user to check existing wallets
      const privyUser = await privyClient.users()._get(user.privyId);

      // Read policy IDs from environment; these must be configured in Privy Console
      const rawPolicyIds = process.env.PRIVY_EMBEDDED_WALLET_POLICY_IDS || "";
      const policyIds = rawPolicyIds
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      
      // Privy's createWallets API automatically handles HD wallet indexing
      // The first wallet will be at index 0, subsequent wallets at higher indices
      const result = await privyClient.wallets().create({
        owner: {
          user_id: user.privyId, // Use Privy ID for wallet operations
        },
        chain_type: "bitcoin-segwit",
        policy_ids: policyIds.length > 0 ? policyIds : [],
        });

      console.log("Bitcoin wallet created. User now has", result.id, " a new wallet");

      // result contains the updated user and wallets
      return res.status(201).json({
        success: true,
        message: "Bitcoin wallet created and managed by Privy",
        userId: user.privyId, // Use Privy ID for wallet operations
        wallet: result,
      });
    } catch (error: any) {
      console.error("Error creating Privy BTC wallet:", error);
      const message = error?.message || "Failed to create BTC wallet";
      return res.status(500).json({ error: message });
    }
  });

  app.get("/api/wallet/:userId", async (req, res) => {
    try {
      const connection = await storage.getWalletConnection(req.params.userId);
      if (!connection) {
        return res.status(404).json({ error: "Wallet connection not found" });
      }
      res.json(connection);
    } catch (error) {
      console.error("Error fetching wallet connection:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Statistics route
  app.get("/api/stats", async (req, res) => {
    try {
      const stats = await storage.getStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // QR code generation
  app.post("/api/qr-code", async (req, res) => {
    try {
      const { data } = req.body;
      if (!data) {
        return res.status(400).json({ error: "Data is required" });
      }
      const qrCode = await QRCode.toDataURL(data);
      res.json({ qrCode });
    } catch (error) {
      console.error("Error generating QR code:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Authentication routes
  app.post("/api/auth/send-otp", async (req, res) => {
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

  app.post("/api/auth/verify-otp", async (req, res) => {
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

  // Google OAuth routes
  app.get("/api/auth/google", async (req, res) => {
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

  app.get("/api/auth/google/callback", async (req, res) => {
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

  // DID resolution endpoint for assets (/.well-known/did/:slug)
  // This resolves asset DIDs published to the web layer
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

  // Serve DID log at path-based endpoint (did.jsonl)
  // According to DID:WebVH spec:
  // - Domain-only DID: did:webvh:example.com -> /.well-known/did.jsonl
  // - Path-based DID: did:webvh:example.com:alice -> /alice/did.jsonl (NO .well-known!)
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

  // Serve resources at /:userSlug/resources/:hash
  // This serves the actual resource files published to the web
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

  // Publish asset to web (migrate from did:peer to did:webvh)
  app.post("/api/assets/:id/publish-to-web", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      const assetId = req.params.id;
      const { domain } = req.body; // Optional custom domain
      
      // Get the asset
      const asset = await storage.getAsset(assetId);
      
      if (!asset) {
        return res.status(404).json({ error: "Asset not found" });
      }
      
      // Verify ownership
      if (asset.userId !== user.id) {
        return res.status(403).json({ error: "You don't own this asset" });
      }
      
      // Check if asset is in did:peer layer
      if (asset.currentLayer !== 'did:peer') {
        return res.status(400).json({ 
          error: "Asset is not in did:peer layer",
          currentLayer: asset.currentLayer 
        });
      }
      
      // Check if asset already has didWebvh
      if (asset.didWebvh) {
        return res.status(400).json({ 
          error: "Asset already published to web",
          didWebvh: asset.didWebvh 
        });
      }
      
      // Use SDK to publish to web
      // For now, we'll simulate this by creating a web-resolvable DID
      // In a full implementation, this would call originalsSdk.lifecycle.publishToWeb()
      
      // Generate did:webvh identifier
      // Format: did:webvh:domain:asset-slug
      const usedDomain = domain || process.env.WEBVH_DOMAIN || `localhost%3A${process.env.PORT || 5000}`;
      const assetSlug = `asset-${assetId.replace('orig_', '')}`;
      const didWebvh = `did:webvh:${usedDomain}:${assetSlug}`;
      
      // Update provenance with migration event
      const currentProvenance = asset.provenance || [];
      const migrationEvent = {
        type: 'migration',
        from: 'did:peer',
        to: 'did:webvh',
        timestamp: new Date().toISOString(),
        actor: user.id,
        didPeer: asset.didPeer,
        didWebvh: didWebvh,
        description: 'Asset published to web layer'
      };
      
      const updatedProvenance = Array.isArray(currentProvenance) 
        ? [...currentProvenance, migrationEvent]
        : [migrationEvent];
      
      // Update the DID document to reflect the new did:webvh identifier
      const updatedDidDocument = asset.didDocument ? {
        ...asset.didDocument,
        id: didWebvh,
        // Update any verification methods or other fields that reference the DID
        ...((asset.didDocument as any).verificationMethod && {
          verificationMethod: ((asset.didDocument as any).verificationMethod as any[]).map((vm: any) => ({
            ...vm,
            controller: didWebvh,
            id: vm.id ? vm.id.replace(asset.didPeer || '', didWebvh) : vm.id
          }))
        })
      } : null;
      
      // Update asset in database
      const updatedAsset = await storage.updateAsset(assetId, {
        currentLayer: 'did:webvh',
        didWebvh: didWebvh,
        didDocument: updatedDidDocument as any,
        provenance: updatedProvenance as any,
      });
      
      if (!updatedAsset) {
        return res.status(500).json({ error: "Failed to update asset" });
      }
      
      // Generate resolver URL
      const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
      const resolverDomain = usedDomain.replace('%3A', ':');
      const resolverUrl = `${protocol}://${resolverDomain}/${assetSlug}/did.jsonld`;
      
      console.log(`✅ Published asset ${assetId} to web: ${didWebvh}`);
      
      res.json({
        success: true,
        message: "Asset published to web successfully",
        asset: {
          id: updatedAsset.id,
          title: updatedAsset.title,
          currentLayer: updatedAsset.currentLayer,
          didPeer: updatedAsset.didPeer,
          didWebvh: updatedAsset.didWebvh,
          provenance: updatedAsset.provenance,
        },
        resolverUrl,
        migration: migrationEvent,
      });
      
    } catch (error) {
      console.error("Error publishing asset to web:", error);
      res.status(500).json({ 
        error: "Failed to publish asset",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Serve DID document at path-based endpoint
  // IMPORTANT: These catch-all routes must be registered LAST to avoid conflicts
  // 
  // According to DID:WebVH spec transformation:
  // - DID format: did:webvh:{url-encoded-domain}:{path-segments}
  // - The domain is URL-encoded (ports use %3A instead of :)
  // - Path-based DIDs resolve to: https://{domain}/{path-segments}/did.jsonld
  // - Domain-only DIDs would use: https://{domain}/.well-known/did.jsonld
  // 
  // Example:
  // - DID: did:webvh:localhost%3A5000:alice
  // - Resolves to: http://localhost:5000/alice/did.jsonld
  // - Log at: http://localhost:5000/alice/did.jsonl
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
