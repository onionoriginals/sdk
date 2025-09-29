import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertAssetSchema, insertWalletConnectionSchema } from "@shared/schema";
import { z } from "zod";
import QRCode from "qrcode";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { PrivyClient } from "@privy-io/server-auth";

// Temporary in-memory storage for OTP codes
const otpStorage = new Map<string, { code: string; expires: number }>();

// Google OAuth2 client
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/auth/google/callback'
);

// Initialize Privy client
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

  const httpServer = createServer(app);
  return httpServer;
}
