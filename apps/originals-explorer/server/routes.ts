import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertAssetSchema, insertAssetTypeSchema, insertWalletConnectionSchema } from "@shared/schema";
import { z } from "zod";
import QRCode from "qrcode";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { PrivyClient } from "@privy-io/node";
import { originalsSdk } from "./originals";
import { createUserDIDWebVH } from "./did-webvh-service";
import multer from "multer";
import { parse as csvParse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { VerifiableCredential } from "@originals/sdk";

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

const privyClient = new PrivyClient({
  appId: process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!
});

// Authentication middleware that uses did:webvh as primary identifier
const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authorizationHeader = req.headers.authorization;
    
    if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: "Missing or invalid authorization header" });
    }

    const token = authorizationHeader.substring(7);
    const verifiedClaims = await privyClient.utils().auth().verifyAuthToken(token);
    
    // Check if user already exists by Privy ID
    let user = await storage.getUserByPrivyId(verifiedClaims.user_id);
    
    // If user doesn't exist, create DID:WebVH and user record
    if (!user) {
      console.log(`Creating DID:WebVH for new user ${verifiedClaims.user_id}...`);
      const didData = await createUserDIDWebVH(verifiedClaims.user_id, privyClient, token);
      
      // Create user with DID as primary identifier
      user = await storage.createUserWithDid(verifiedClaims.user_id, didData.did, didData);
    }
    
    // Add user info to request using did:webvh as primary ID
    (req as any).user = {
      id: user.did, // Primary identifier is now did:webvh
      privyId: verifiedClaims.user_id, // Keep Privy ID for wallet operations
      did: user.did,
      authToken: token, // Store JWT for Privy authorization context
    };
    
    next();
  } catch (error) {
    console.error("Authentication error:", error);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

export async function registerRoutes(app: Express): Promise<Server> {
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
        privyId: user.privyId, // Keep for reference
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

      let contentHash: string;
      let fileBuffer: Buffer;
      let contentType: string;
      let actualMediaUrl: string | null = null;

      // Step 1: Hash Media Content
      if (req.file) {
        // File uploaded
        fileBuffer = req.file.buffer;
        contentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        contentType = req.file.mimetype;
        
        // For uploaded files, we could store them and generate a URL
        // For now, we'll use data URI
        const base64Data = fileBuffer.toString('base64');
        actualMediaUrl = `data:${contentType};base64,${base64Data}`;
      } else if (mediaUrl) {
        // URL provided - fetch and hash
        try {
          const response = await fetch(mediaUrl);
          if (!response.ok) {
            return res.status(400).json({ 
              error: `Failed to fetch media from URL: ${response.statusText}` 
            });
          }
          
          const arrayBuffer = await response.arrayBuffer();
          fileBuffer = Buffer.from(arrayBuffer);
          contentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
          contentType = response.headers.get('content-type') || 'application/octet-stream';
          actualMediaUrl = mediaUrl;
        } catch (fetchError: any) {
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
      // For binary files, we'll create a metadata representation for the DID
      // The actual content is stored via URL or data URI
      const assetMetadata = {
        title: title,
        description: description || '',
        category: category || '',
        tags: parsedTags,
        contentType: contentType,
        contentHash: contentHash,
        ...parsedMetadata
      };
      
      const metadataString = JSON.stringify(assetMetadata);
      const metadataHash = crypto.createHash('sha256').update(metadataString).digest('hex');
      
      const resources = [{
        id: `resource-${Date.now()}`,
        type: contentType.startsWith('image/') ? 'image' : 
              contentType.startsWith('video/') ? 'video' :
              contentType.startsWith('audio/') ? 'audio' : 'file',
        contentType: 'application/json', // Metadata is JSON
        hash: metadataHash,
        content: metadataString, // Store metadata as content for DID generation
        url: actualMediaUrl || undefined
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
        tags: parsedTags.length > 0 ? parsedTags : null,
        mediaUrl: actualMediaUrl,
        metadata: {
          ...parsedMetadata,
          contentType: contentType,
          contentHash: contentHash,
          resourceId: resources[0].id
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
  app.get("/:userSlug/did.jsonld", async (req, res) => {
    try {
      const { userSlug } = req.params;
      
      // Look up user by DID slug
      const user = await storage.getUserByDidSlug(userSlug);
      
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
