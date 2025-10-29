import { Router } from "express";
import { storage } from "../storage";
import { insertWalletConnectionSchema } from "@shared/schema";
import { z } from "zod";

const router = Router();

/**
 * Connect wallet
 */
router.post("/connect", async (req, res) => {
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

/**
 * Get wallet connection by user ID
 */
router.get("/:userId", async (req, res) => {
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

export default router;
