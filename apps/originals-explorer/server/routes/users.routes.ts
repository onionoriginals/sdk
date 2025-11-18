import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { storage } from "../storage";

const router = Router();

/**
 * Get authenticated user
 */
router.get("/", authenticateUser, async (req, res) => {
  try {
    const user = (req as any).user;
    res.json({
      id: user.id, // Database UUID
      did: user.did,
      email: user.email,
      turnkeySubOrgId: user.turnkeySubOrgId,
    });
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
