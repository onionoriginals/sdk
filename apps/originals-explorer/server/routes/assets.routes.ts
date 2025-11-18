import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { storage } from "../storage";
import { insertAssetSchema, insertAssetTypeSchema } from "@shared/schema";
import { z } from "zod";
import crypto from "crypto";
import { originalsSdk } from "../originals";
import multer from "multer";
import { parse as csvParse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { VerifiableCredential } from "@originals/sdk";

const router = Router();

// Configure multer for file uploads (CSV/XLSX)
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

/**
 * Helper function to validate URLs against SSRF attacks
 */
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

/**
 * ASSET CRUD OPERATIONS
 */

// Get all assets for authenticated user
router.get("/", authenticateUser, async (req, res) => {
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

// Get single asset by ID
router.get("/:id", async (req, res) => {
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

// Create asset from JSON
router.post("/", async (req, res) => {
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

// Update asset metadata
router.put("/:id", async (req, res) => {
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

/**
 * ASSET TYPES
 * TODO: Eventually these should be Originals assets themselves
 * For now, keeping them as separate entities
 */

// Get all asset types for authenticated user
router.get("/asset-types", authenticateUser, async (req, res) => {
  try {
    const user = (req as any).user;
    const assetTypes = await storage.getAssetTypesByUserId(user.id);
    res.json(assetTypes);
  } catch (error) {
    console.error("Error fetching asset types:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create new asset type
router.post("/asset-types", authenticateUser, async (req, res) => {
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

/**
 * ASSET MIGRATION
 * Generic endpoint for migrating assets between layers
 * Supports: did:peer -> did:webvh -> did:btco
 */
router.post("/:id/migrate", authenticateUser, async (req, res) => {
  try {
    const user = (req as any).user;
    const assetId = req.params.id;
    const { targetLayer } = req.body;

    // Validate target layer
    const validLayers = ['did:webvh', 'did:btco'];
    if (!validLayers.includes(targetLayer)) {
      return res.status(400).json({
        error: "Invalid target layer",
        details: `Target layer must be one of: ${validLayers.join(', ')}`
      });
    }

    // Get asset from database
    const asset = await storage.getAsset(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    // Check ownership
    if (asset.userId !== user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Validate migration path
    const currentLayer = asset.currentLayer;
    if (currentLayer === 'did:peer' && targetLayer === 'did:btco') {
      return res.status(400).json({
        error: 'Invalid migration path',
        details: 'Cannot migrate directly from did:peer to did:btco. Must migrate to did:webvh first.'
      });
    }

    if (currentLayer === targetLayer) {
      return res.status(400).json({
        error: 'Already at target layer',
        details: `Asset is already in ${targetLayer} layer.`
      });
    }

    // TODO: Implement actual migration logic using Originals SDK
    // For now, return a placeholder response
    res.status(501).json({
      message: "Migration endpoint - implementation pending",
      assetId,
      currentLayer,
      targetLayer,
      note: "This will use Originals SDK lifecycle.publishToWeb() or lifecycle.inscribeOnBitcoin()"
    });

  } catch (error: any) {
    console.error("Error migrating asset:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message
    });
  }
});

/**
 * BATCH OPERATIONS
 * Generic endpoint for batch asset creation
 * Supports creating multiple assets in one request
 */
router.post("/batch", authenticateUser, async (req, res) => {
  try {
    const user = (req as any).user;
    const { assets } = req.body;

    // Validate input
    if (!Array.isArray(assets)) {
      return res.status(400).json({
        error: "Invalid input",
        details: "Request body must contain an 'assets' array"
      });
    }

    if (assets.length === 0) {
      return res.status(400).json({
        error: "Empty batch",
        details: "Assets array cannot be empty"
      });
    }

    if (assets.length > 100) {
      return res.status(400).json({
        error: "Batch too large",
        details: "Maximum 100 assets per batch"
      });
    }

    const createdAssets = [];
    const errors: Array<{ index: number; error: string }> = [];

    // Process each asset
    for (let i = 0; i < assets.length; i++) {
      try {
        const assetData = {
          ...assets[i],
          userId: user.id,
        };

        // Validate and create asset
        const validatedAsset = insertAssetSchema.parse(assetData);
        const asset = await storage.createAsset(validatedAsset);
        createdAssets.push(asset);

      } catch (error: any) {
        errors.push({
          index: i,
          error: error.message || "Failed to create asset"
        });
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
    console.error("Error processing batch:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message
    });
  }
});

export default router;
