import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  // New canonical DID identifier (did:webvh)
  did_webvh: text("did_webvh").unique(), // did:webvh identifier (canonical after migration)
  didWebvhDocument: jsonb("did_webvh_document"), // Complete did:webvh DID document
  didWebvhCreatedAt: timestamp("did_webvh_created_at"), // When did:webvh was created
  // Legacy DID identifier (did:privy) - kept for migration period
  did_privy: text("did_privy").unique(), // did:privy identifier (legacy)
  // DID-related fields (Privy-managed keys - used for both DIDs during migration)
  did: text("did"), // DEPRECATED: old field, use did_webvh
  didDocument: jsonb("did_document"), // DEPRECATED: old field, use didWebvhDocument
  authWalletId: text("auth_wallet_id"), // Privy wallet ID for authentication (Bitcoin)
  assertionWalletId: text("assertion_wallet_id"), // Privy wallet ID for assertions (Stellar/ED25519)
  updateWalletId: text("update_wallet_id"), // Privy wallet ID for DID updates (Stellar/ED25519)
  authKeyPublic: text("auth_key_public"), // Bitcoin public key in multibase format
  assertionKeyPublic: text("assertion_key_public"), // ED25519 public key in multibase format
  updateKeyPublic: text("update_key_public"), // ED25519 public key in multibase format
  didCreatedAt: timestamp("did_created_at"), // DEPRECATED: use didWebvhCreatedAt
});

export const assets = pgTable("assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  title: text("title").notNull(),
  description: text("description"),
  category: varchar("category"),
  tags: text("tags").array(),
  mediaUrl: text("media_url"),
  metadata: jsonb("metadata"),
  credentials: jsonb("credentials"),
  status: varchar("status").notNull().default("draft"), // draft, pending, completed
  assetType: varchar("asset_type").notNull(), // original, migrated
  originalReference: text("original_reference"), // for migrated assets
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const walletConnections = pgTable("wallet_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  walletAddress: text("wallet_address").notNull(),
  walletType: varchar("wallet_type").notNull(), // unisat, xverse, etc.
  isActive: varchar("is_active").notNull().default("true"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const assetTypes = pgTable("asset_types", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  properties: jsonb("properties").notNull().default('[]'), // Array of AssetProperty objects
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertAssetSchema = createInsertSchema(assets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  title: z.string().min(1, "Title is required"),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const insertWalletConnectionSchema = createInsertSchema(walletConnections).omit({
  id: true,
  createdAt: true,
});

export const insertAssetTypeSchema = createInsertSchema(assetTypes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  name: z.string().min(1, "Asset type name is required"),
  properties: z.array(z.object({
    id: z.string(),
    key: z.string(),
    label: z.string(),
    type: z.enum(["text", "number", "boolean", "date", "select"]),
    required: z.boolean().optional(),
    options: z.array(z.string()).optional(),
  })).optional(),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertAsset = z.infer<typeof insertAssetSchema>;
export type Asset = typeof assets.$inferSelect;
export type InsertWalletConnection = z.infer<typeof insertWalletConnectionSchema>;
export type WalletConnection = typeof walletConnections.$inferSelect;
export type InsertAssetType = z.infer<typeof insertAssetTypeSchema>;
export type AssetType = typeof assetTypes.$inferSelect;
