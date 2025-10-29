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

/**
 * Ensure user has a DID:WebVH (automatically created during authentication)
 */
router.post("/ensure-did", authenticateUser, async (req, res) => {
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

export default router;
