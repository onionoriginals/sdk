import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertAssetSchema, insertAssetTypeSchema, insertWalletConnectionSchema } from "@shared/schema";
import { z } from "zod";
import QRCode from "qrcode";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { PrivyClient } from "@privy-io/server-auth";
import { originalsSdk } from "./originals";
import { createUserDID } from "./did-service";
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

// Google OAuth2 client
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/auth/google/callback'
);

const privyClient = new PrivyClient(
  process.env.PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
);

// Middleware to authenticate requests using Privy
const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authorizationHeader = req.headers.authorization;
    console.log("Authorization header:", authorizationHeader ? `${authorizationHeader.substring(0, 20)}...` : "missing");
    
    if (!authorizationHeader) {
      return res.status(401).json({ error: "Missing authorization header" });
    }

    if (!authorizationHeader.startsWith('Bearer ')) {
      console.log("Invalid authorization header format");
      return res.status(401).json({ error: "Invalid authorization header format" });
    }

    const token = authorizationHeader.substring(7);
    console.log("Token length:", token.length);
    console.log("Token preview:", token.substring(0, 50) + "...");
    
    const verifiedClaims = await privyClient.verifyAuthToken(token);
    console.log("Token verified successfully for user:", verifiedClaims.userId);
    
    // Add user info to request
    (req as any).user = {
      id: verifiedClaims.userId,
      privyDid: verifiedClaims.userId,
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
        id: user.id,
        privyDid: user.privyDid,
      });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Ensure user has a DID (create if doesn't exist)
  app.post("/api/user/ensure-did", authenticateUser, async (req, res) => {
    try {
      const user = (req as any).user;
      
      // Ensure user record exists (creates if new Privy user)
      await storage.ensureUser(user.id);
      
      // Check if user already has a DID
      const existingUser = await storage.getUser(user.id);
      if (existingUser?.did) {
        console.log(`User ${user.id} already has DID: ${existingUser.did}`);
        return res.json({ 
          did: existingUser.did, 
          didDocument: existingUser.didDocument,
          created: false 
        });
      }

      console.log(`Creating DID for user ${user.id}...`);
      
      // Create DID using Privy wallets
      const didData = await createUserDID(user.id, privyClient);
      
      // Store DID data in user record (now guaranteed to exist)
      await storage.updateUser(user.id, didData);
      
      console.log(`DID created successfully: ${didData.did}`);
      
      return res.json({ 
        did: didData.did, 
        didDocument: didData.didDocument,
        created: true 
      });
    } catch (error) {
      console.error("Error ensuring user DID:", error);
      return res.status(500).json({ 
        error: "Failed to create DID",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Assets routes
  app.get("/api/assets", async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }
      const assets = await storage.getAssetsByUserId(userId as string);
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
        userId: user.id,
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
          // Validate required fields
          if (!row.title || !row.assetType || !row.category) {
            errors.push({
              row: i + 2, // +2 because row 1 is header, and i starts at 0
              error: "Missing required fields (title, assetType, category)"
            });
            continue;
          }

          // Parse tags if provided
          let tags: string[] = [];
          if (row.tags) {
            tags = typeof row.tags === 'string' 
              ? row.tags.split(',').map((t: string) => t.trim())
              : row.tags;
          }

          // Extract custom properties (any columns not in standard fields)
          const standardFields = ['title', 'description', 'category', 'tags', 'mediaUrl', 'status', 'assetType'];
          const customProperties: Record<string, any> = {};
          for (const [key, value] of Object.entries(row)) {
            if (!standardFields.includes(key)) {
              customProperties[key] = value;
            }
          }

          // Create asset data
          const assetData = {
            title: row.title,
            description: row.description || "",
            category: row.category,
            tags,
            mediaUrl: row.mediaUrl || "",
            metadata: {
              assetTypeId: row.assetType,
              assetTypeName: row.assetType,
              customProperties,
              uploadedViaSpreadsheet: true,
            },
            userId: user.id,
            assetType: "original",
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
        const assetTypeName = firstAsset.metadata?.assetTypeName;
        
        if (assetTypeName) {
          const existingTypes = await storage.getAssetTypesByUserId(user.id);
          const typeExists = existingTypes.some(t => t.name === assetTypeName);

          if (!typeExists) {
            // Use the custom properties from the first created asset
            const customProperties = firstAsset.metadata?.customProperties || {};
            const properties = Object.keys(customProperties).map((key, index) => ({
              id: `prop_${index}`,
              key,
              label: key.charAt(0).toUpperCase() + key.slice(1),
              type: "text" as const,
              required: false,
            }));

            await storage.createAssetType({
              userId: user.id,
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
      let btcWallet = await privyClient.walletApi.createWallet({
        owner: {
          userId: user.id,
        },
        chainType: "bitcoin-segwit",
        policyIds: policyIds.length > 0 ? policyIds : [],
      });
      console.log("Bitcoin wallet created:", btcWallet);
      
      let stellarWallet = await privyClient.walletApi.createWallet({
        owner: {
          userId: user.id,
        },
        chainType: "stellar",
        policyIds: policyIds.length > 0 ? policyIds : [],
      });
      console.log("Stellar wallet created:", stellarWallet);

      // Fetch updated user to get all wallets (since there could be multiple)
      const updatedUser = await privyClient.getUserById(user.id);
      const allWallets = updatedUser.linkedAccounts?.filter((a: any) => a.type === 'wallet') || [];

      console.log("Bitcoin and Stellar wallets created. User now has", allWallets.length, "wallets");

      // Privy returns the wallet info with public keys
      // Private keys are managed entirely by Privy's infrastructure
      return res.status(201).json({
        success: true,
        message: "Bitcoin and Stellar wallets created and managed by Privy",
        userId: user.id,
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
      const privyUser = await privyClient.getUserById(user.id);
      
      // Read policy IDs from environment (may be required by Privy)
      const rawPolicyIds = process.env.PRIVY_EMBEDDED_WALLET_POLICY_IDS || "";
      const policyIds = rawPolicyIds
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      
      // Use Privy to create a Stellar wallet (ED25519-based)
      // Privy manages all keys - we never see or store private keys
      // The API will automatically handle HD wallet indexing
      const result = await privyClient.createWallets({
        userId: user.id,
        wallets: [
          {
            chainType: "stellar",
            policyIds: policyIds.length > 0 ? policyIds : [],
          },
        ],
      });

      console.log("Stellar wallet created. User now has", result.linkedAccounts?.filter((a: any) => a.type === 'wallet').length, "wallets");

      // Privy returns the wallet info with public key
      // Private key is managed entirely by Privy's infrastructure
      return res.status(201).json({
        success: true,
        message: "Stellar wallet created with ED25519 keys managed by Privy",
        userId: user.id,
        wallets: result.linkedAccounts?.filter((a: any) => a.type === 'wallet'),
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
      const privyUser = await privyClient.getUserById(user.id);

      // Read policy IDs from environment; these must be configured in Privy Console
      const rawPolicyIds = process.env.PRIVY_EMBEDDED_WALLET_POLICY_IDS || "";
      const policyIds = rawPolicyIds
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      
      // Privy's createWallets API automatically handles HD wallet indexing
      // The first wallet will be at index 0, subsequent wallets at higher indices
      const result = await privyClient.createWallets({
        userId: user.id,
        wallets: [
          {
            chainType: "bitcoin-segwit",
            policyIds,
          },
        ],
      });

      console.log("Bitcoin wallet created. User now has", result.linkedAccounts?.filter((a: any) => a.type === 'wallet').length, "wallets");

      // result contains the updated user and wallets
      return res.status(201).json({
        success: true,
        message: "Bitcoin wallet created and managed by Privy",
        userId: user.id,
        wallets: result.linkedAccounts?.filter((a: any) => a.type === 'wallet'),
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

  // Serve DID document at path-based endpoint
  // IMPORTANT: This catch-all route must be registered LAST to avoid conflicts
  // 
  // According to DID:WebVH spec transformation:
  // - DID format: did:webvh:{url-encoded-domain}:{path-segments}
  // - The domain is URL-encoded (ports use %3A instead of :)
  // - Resolves to: https://{domain}/{path-segments}/did.jsonld
  // 
  // Example:
  // - DID: did:webvh:localhost%3A5000:user123
  // - Resolves to: http://localhost:5000/user123/did.jsonld
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
