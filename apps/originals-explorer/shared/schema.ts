import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  // DID-related fields (Privy-managed keys)
  did: text("did"), // did:webvh identifier
  didDocument: jsonb("did_document"), // Complete DID document
  didLog: jsonb("did_log"), // DID log (did.jsonl content)
  didSlug: text("did_slug"), // User slug extracted from DID
  authWalletId: text("auth_wallet_id"), // Privy wallet ID for authentication (Bitcoin)
  assertionWalletId: text("assertion_wallet_id"), // Privy wallet ID for assertions (Stellar/ED25519)
  updateWalletId: text("update_wallet_id"), // Privy wallet ID for DID updates (Stellar/ED25519)
  authKeyPublic: text("auth_key_public"), // Bitcoin public key in multibase format
  assertionKeyPublic: text("assertion_key_public"), // ED25519 public key in multibase format
  updateKeyPublic: text("update_key_public"), // ED25519 public key in multibase format
  didCreatedAt: timestamp("did_created_at"), // When the DID was created
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
  // Source tracking for imports
  source: varchar("source").default("manual"), // manual, google-drive-import, etc.
  sourceMetadata: jsonb("source_metadata"), // Source-specific data (e.g., Google Drive file ID, links)
  // Layer tracking fields
  currentLayer: text("current_layer").default("did:peer"), // did:peer, did:webvh, or did:btco
  didPeer: text("did_peer"), // DID identifier for peer layer
  didWebvh: text("did_webvh"), // DID identifier for web layer
  didBtco: text("did_btco"), // DID identifier for Bitcoin layer
  provenance: jsonb("provenance"), // Complete provenance chain
  didDocument: jsonb("did_document"), // DID document for the asset
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

export const googleDriveImports = pgTable("google_drive_imports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  folderId: text("folder_id").notNull(), // Google Drive folder ID
  folderName: text("folder_name").notNull(), // User-friendly folder name
  status: varchar("status").notNull().default("pending"), // pending, processing, completed, failed
  totalFiles: varchar("total_files"), // Total number of files to process
  processedFiles: varchar("processed_files").default("0"), // Number of files processed
  failedFiles: varchar("failed_files").default("0"), // Number of failed files
  errorDetails: jsonb("error_details"), // Array of error objects {fileId, fileName, error}
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
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
  title: z.string().optional(), // Title is now optional
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  // Source tracking
  source: z.enum(["manual", "google-drive-import"]).optional(),
  sourceMetadata: z.any().optional(),
  // Layer tracking fields
  currentLayer: z.enum(["did:peer", "did:webvh", "did:btco"]).optional(),
  didPeer: z.string().optional(),
  didWebvh: z.string().optional(),
  didBtco: z.string().optional(),
  provenance: z.any().optional(),
  didDocument: z.any().optional(),
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

export const insertGoogleDriveImportSchema = createInsertSchema(googleDriveImports).omit({
  id: true,
  createdAt: true,
  completedAt: true,
}).extend({
  folderId: z.string().min(1, "Folder ID is required"),
  folderName: z.string().min(1, "Folder name is required"),
  status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
  errorDetails: z.array(z.object({
    fileId: z.string(),
    fileName: z.string(),
    error: z.string(),
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
export type InsertGoogleDriveImport = z.infer<typeof insertGoogleDriveImportSchema>;
export type GoogleDriveImport = typeof googleDriveImports.$inferSelect;

// Layer type for type-safe layer filtering
export type AssetLayer = "did:peer" | "did:webvh" | "did:btco";
// Source type for asset origin tracking
export type AssetSource = "manual" | "google-drive-import";
