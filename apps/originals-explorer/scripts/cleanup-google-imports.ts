#!/usr/bin/env bun
/**
 * Cleanup script to delete Google Drive import assets with large embedded data
 * Run with: bun scripts/cleanup-google-imports.ts
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { assets } from "../shared/schema.ts";
import { eq } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL not set in environment");
  process.exit(1);
}

console.log("🔗 Connecting to database...");
const pool = new Pool({ connectionString: DATABASE_URL });
const db = drizzle(pool);

try {
  // Count existing Google Drive imports
  const existing = await db
    .select()
    .from(assets)
    .where(eq(assets.originalReference, 'google-drive-import'));
  
  console.log(`📊 Found ${existing.length} Google Drive import assets`);
  
  if (existing.length === 0) {
    console.log("✅ No assets to delete");
    await pool.end();
    process.exit(0);
  }

  // Delete them
  console.log("🗑️  Deleting Google Drive import assets...");
  const result = await db
    .delete(assets)
    .where(eq(assets.originalReference, 'google-drive-import'));
  
  console.log(`✅ Deleted ${existing.length} Google Drive import assets`);
  
  // Show remaining assets count
  const remaining = await db.select().from(assets);
  console.log(`📊 Remaining assets in database: ${remaining.length}`);
  
} catch (error: any) {
  console.error("❌ Error:", error.message);
  process.exit(1);
} finally {
  await pool.end();
  console.log("👋 Done!");
}

