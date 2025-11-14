import { Router } from "express";
import { storage } from "../storage";
import QRCode from "qrcode";
import { originalsSdk } from "../originals";

const router = Router();

/**
 * Health check for Originals SDK integration
 */
router.get("/originals/health", async (_req, res) => {
  try {
    // Accessing the instance verifies import/initialization without performing network operations
    void originalsSdk;
    res.json({ initialized: true });
  } catch (_e) {
    res.status(500).json({ initialized: false });
  }
});

/**
 * Get system statistics
 */
router.get("/stats", async (req, res) => {
  try {
    const stats = await storage.getStats();
    res.json(stats);
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Generate QR code
 */
router.post("/qr-code", async (req, res) => {
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

export default router;
