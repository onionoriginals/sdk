import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { storage } from "../storage";
import { originalsSdk } from "../originals";
import crypto from "crypto";

const router = Router();

/**
 * DEV/DEMO ROUTES
 * These endpoints are for development and testing purposes only
 */

// Generate random did:peer asset (for testing/demo)
router.post("/generate-random-asset", authenticateUser, async (req, res) => {
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

export default router;
