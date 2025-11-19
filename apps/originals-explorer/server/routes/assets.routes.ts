import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { storage } from "../storage";
import { insertAssetSchema, insertAssetTypeSchema } from "@shared/schema";
import { z } from "zod";
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

export default router;
