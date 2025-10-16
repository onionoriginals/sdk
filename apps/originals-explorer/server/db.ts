// Simple PostgreSQL storage using Drizzle ORM
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import { Pool } from "pg";

// Import schema
import { 
  users, 
  assets, 
  walletConnections, 
  assetTypes,
  googleDriveImports,
  User,
  Asset,
  WalletConnection,
  AssetType,
  GoogleDriveImport,
  AssetLayer,
  InsertAsset,
  InsertUser,
  InsertWalletConnection,
  InsertAssetType,
  InsertGoogleDriveImport
} from "../shared/schema.ts";

interface GetAssetsByUserIdOptions {
  layer?: AssetLayer | 'all';
}

interface DIDData {
  didDocument: any;
  didLog?: any;
  didSlug?: string;
  authWalletId: string;
  assertionWalletId: string;
  updateWalletId: string;
  authKeyPublic: string;
  assertionKeyPublic: string;
  updateKeyPublic: string;
  didCreatedAt: Date;
}

interface Stats {
  totalAssets: number;
  verifiedAssets: number;
  migratedAssets: number;
}

export class DatabaseStorage {
  private pool: Pool;
  private db: NodePgDatabase;
  private signingKeys: Map<string, any[]>;
  private didDocuments: Map<string, any>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.db = drizzle(this.pool);
    this.signingKeys = new Map();
    this.didDocuments = new Map();
    console.log("✅ PostgreSQL DatabaseStorage initialized");
  }

  // User methods
  async getUser(id: string): Promise<User | undefined> {
    const result = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    return result[0];
  }

  async getUserByPrivyId(privyUserId: string): Promise<User | undefined> {
    const byUsername = await this.getUserByUsername(privyUserId);
    return byUsername || undefined;
  }

  async createUser(insertUser: InsertUser | (Omit<Partial<User>, 'id'> & { username: string; password: string })): Promise<User> {
    const result = await this.db.insert(users).values(insertUser as any).returning();
    return result[0];
  }

  async updateUser(userId: string, updates: Partial<User>): Promise<User> {
    const result = await this.db.update(users).set(updates).where(eq(users.id, userId)).returning();
    return result[0];
  }

  async ensureUser(privyUserId: string): Promise<User> {
    const existing = await this.getUserByPrivyId(privyUserId);
    if (existing) return existing;
    return this.createUser({ username: privyUserId, password: '' });
  }

  async getUserByDidSlug(slug: string): Promise<User | undefined> {
    const result = await this.db.select().from(users).where(eq(users.didSlug, slug)).limit(1);
    return result[0];
  }

  async getUserByDid(did: string): Promise<User | undefined> {
    const result = await this.db.select().from(users).where(eq(users.did, did)).limit(1);
    return result[0];
  }

  async createUserWithDid(privyUserId: string, did: string, didData: DIDData): Promise<User> {
    // Check if user already exists by Privy ID
    const existing = await this.getUserByUsername(privyUserId);
    
    if (existing) {
      // Update existing user with DID data (keep the same database ID)
      return await this.updateUser(existing.id, {
        did,
        didDocument: didData.didDocument,
        didLog: didData.didLog || null,
        didSlug: didData.didSlug || null,
        authWalletId: didData.authWalletId,
        assertionWalletId: didData.assertionWalletId,
        updateWalletId: didData.updateWalletId,
        authKeyPublic: didData.authKeyPublic,
        assertionKeyPublic: didData.assertionKeyPublic,
        updateKeyPublic: didData.updateKeyPublic,
        didCreatedAt: didData.didCreatedAt,
      });
    }

    // Check if user already exists by DID
    const existingByDid = await this.getUserByDid(did);
    if (existingByDid) {
      return existingByDid;
    }

    // Create new user (database will generate UUID as ID)
    return this.createUser({
      username: privyUserId,  // Keep Privy ID as username for lookup
      password: '',
      did,
      didDocument: didData.didDocument,
      didLog: didData.didLog || null,
      didSlug: didData.didSlug || null,
      authWalletId: didData.authWalletId,
      assertionWalletId: didData.assertionWalletId,
      updateWalletId: didData.updateWalletId,
      authKeyPublic: didData.authKeyPublic,
      assertionKeyPublic: didData.assertionKeyPublic,
      updateKeyPublic: didData.updateKeyPublic,
      didCreatedAt: didData.didCreatedAt,
    });
  }

  // Asset methods  
  async getAsset(id: string): Promise<Asset | undefined> {
    const result = await this.db.select().from(assets).where(eq(assets.id, id)).limit(1);
    return result[0];
  }

  async getAssetsByUserId(userId: string, options?: GetAssetsByUserIdOptions): Promise<Asset[]> {
    const result = await this.db.select().from(assets).where(eq(assets.userId, userId));
    if (options?.layer && options.layer !== 'all') {
      return result.filter(asset => asset.currentLayer === options.layer);
    }
    return result;
  }

  async getAssetsByUserDid(userDid: string): Promise<Asset[]> {
    const user = await this.getUserByDid(userDid);
    if (!user) return [];
    return this.getAssetsByUserId(user.id);
  }

  async createAsset(insertAsset: InsertAsset): Promise<Asset> {
    const result = await this.db.insert(assets).values({
      ...insertAsset,
      title: insertAsset.title || "Untitled Asset",
      status: insertAsset.status || "draft",
      assetType: insertAsset.assetType || "original",
      currentLayer: insertAsset.currentLayer || "did:peer",
    }).returning();
    return result[0];
  }

  async updateAsset(id: string, updates: Partial<Asset>): Promise<Asset> {
    const result = await this.db.update(assets)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(assets.id, id))
      .returning();
    return result[0];
  }

  // Wallet methods
  async getWalletConnection(userId: string): Promise<WalletConnection | undefined> {
    const result = await this.db.select().from(walletConnections)
      .where(and(eq(walletConnections.userId, userId), eq(walletConnections.isActive, "true")))
      .limit(1);
    return result[0];
  }

  async createWalletConnection(insertConnection: InsertWalletConnection): Promise<WalletConnection> {
    const result = await this.db.insert(walletConnections).values({
      ...insertConnection,
      isActive: insertConnection.isActive || "true",
    }).returning();
    return result[0];
  }

  async updateWalletConnection(userId: string, updates: Partial<WalletConnection>): Promise<WalletConnection> {
    const result = await this.db.update(walletConnections)
      .set(updates)
      .where(eq(walletConnections.userId, userId))
      .returning();
    return result[0];
  }

  // Signing keys (in-memory for security)
  async storeSigningKey(userId: string, key: any): Promise<void> {
    const keys = this.signingKeys.get(userId) || [];
    keys.push(key);
    this.signingKeys.set(userId, keys);
  }

  async getSigningKeys(userId: string): Promise<any[]> {
    return this.signingKeys.get(userId) || [];
  }

  // Asset types
  async getAssetType(id: string): Promise<AssetType | undefined> {
    const result = await this.db.select().from(assetTypes).where(eq(assetTypes.id, id)).limit(1);
    return result[0];
  }

  async getAssetTypesByUserId(userId: string): Promise<AssetType[]> {
    return this.db.select().from(assetTypes).where(eq(assetTypes.userId, userId));
  }

  async createAssetType(insertAssetType: InsertAssetType): Promise<AssetType> {
    const result = await this.db.insert(assetTypes).values({
      ...insertAssetType,
      properties: insertAssetType.properties || [],
    }).returning();
    return result[0];
  }

  async updateAssetType(id: string, updates: Partial<AssetType>): Promise<AssetType> {
    const result = await this.db.update(assetTypes)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(assetTypes.id, id))
      .returning();
    return result[0];
  }

  // DID documents (in-memory)
  async storeDIDDocument(slug: string, data: any): Promise<void> {
    this.didDocuments.set(slug, data);
  }

  async getDIDDocument(slug: string): Promise<any | undefined> {
    return this.didDocuments.get(slug);
  }

  // Google Drive import methods
  async createGoogleDriveImport(importData: InsertGoogleDriveImport): Promise<GoogleDriveImport> {
    const [result] = await this.db.insert(googleDriveImports).values(importData).returning();
    return result;
  }

  async getGoogleDriveImport(importId: string): Promise<GoogleDriveImport | undefined> {
    const [result] = await this.db.select().from(googleDriveImports).where(eq(googleDriveImports.id, importId));
    return result;
  }

  async getGoogleDriveImportsByUserId(userId: string): Promise<GoogleDriveImport[]> {
    return await this.db.select().from(googleDriveImports).where(eq(googleDriveImports.userId, userId));
  }

  async updateGoogleDriveImport(importId: string, updates: Partial<GoogleDriveImport>): Promise<GoogleDriveImport | undefined> {
    const [result] = await this.db.update(googleDriveImports)
      .set(updates)
      .where(eq(googleDriveImports.id, importId))
      .returning();
    return result;
  }

  async createAssetFromGoogleDrive(data: {
    userId: string;
    importId: string;
    title: string;
    didPeer: string;
    didDocument: any;
    sourceMetadata: any;
  }): Promise<string> {
    const asset = await this.createAsset({
      userId: data.userId,
      title: data.title,
      assetType: 'original',
      status: 'completed',
      source: 'google-drive-import',
      sourceMetadata: {
        ...data.sourceMetadata,
        importId: data.importId,
      },
      currentLayer: 'did:peer',
      didPeer: data.didPeer,
      didDocument: data.didDocument,
      mediaUrl: data.sourceMetadata.webViewLink || data.sourceMetadata.thumbnailLink,
    });
    return asset.id;
  }

  // Stats
  async getStats(): Promise<Stats> {
    const allAssets = await this.db.select().from(assets);
    return {
      totalAssets: allAssets.length,
      verifiedAssets: allAssets.filter(a => a.credentials && Object.keys(a.credentials).length > 0).length,
      migratedAssets: allAssets.filter(a => a.assetType === "migrated").length,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

