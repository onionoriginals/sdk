#!/usr/bin/env bun
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";

const { Pool } = pg;

async function wipeDatabase() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("❌ DATABASE_URL environment variable is not set");
    process.exit(1);
  }

  console.log("⚠️  Warning: This will delete all data from the database!");
  console.log("📊 Wiping database...\n");

  const pool = new Pool({
    connectionString: databaseUrl,
  });

  const db = drizzle(pool);

  try {
    // Delete all data from tables (in order to respect foreign key constraints)
    await db.execute(sql`TRUNCATE TABLE wallet_connections CASCADE`);
    console.log("✓ Cleared wallet_connections");

    await db.execute(sql`TRUNCATE TABLE assets CASCADE`);
    console.log("✓ Cleared assets");

    await db.execute(sql`TRUNCATE TABLE asset_types CASCADE`);
    console.log("✓ Cleared asset_types");

    await db.execute(sql`TRUNCATE TABLE users CASCADE`);
    console.log("✓ Cleared users");

    console.log("\n✅ Database wiped successfully!");
  } catch (error) {
    console.error("\n❌ Error wiping database:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

wipeDatabase();
