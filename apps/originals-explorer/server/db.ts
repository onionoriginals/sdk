// Simple PostgreSQL storage using Drizzle ORM
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";

// Import schema
import { 
  users, 
  assets, 
  walletConnections, 
  assetTypes,
  User,
  Asset,
  WalletConnection,
  AssetType,
  AssetLayer,
  InsertAsset,
  InsertUser,
  InsertWalletConnection,
  InsertAssetType
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

  async getUserByTurnkeyId(turnkeySubOrgId: string): Promise<User | undefined> {
    const result = await this.db.select().from(users).where(eq(users.turnkeySubOrgId, turnkeySubOrgId)).limit(1);
    return result[0];
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

  async createUserWithDid(identifierId: string, email: string, did: string, didData: DIDData): Promise<User> {
    // Check if user already exists by Turnkey ID
    const existing = await this.getUserByTurnkeyId(identifierId);
    
    if (existing) {
      // Update existing user with DID data (keep the same database ID)
      return await this.updateUser(existing.id, {
        email,
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

    // Check if user already exists by email/username
    const existingByUsername = await this.getUserByUsername(email);
    if (existingByUsername) {
      // Update existing user with Turnkey and DID data
      return await this.updateUser(existingByUsername.id, {
        email,
        turnkeySubOrgId: identifierId,
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

    // Create new user (database will generate UUID as ID)
    return this.createUser({
      username: email,  // Use full email as username to ensure uniqueness
      password: '',
      email,
      turnkeySubOrgId: identifierId,
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

  async createAssetFromGoogleDrive(data: {
    userId: string;
    importId: string;
    title: string;
    didPeer: string;
    didDocument: any;
    resources: any[];
    sourceMetadata: any;
  }): Promise<Asset> {
    const assetValues = {
      userId: data.userId,
      title: data.title,
      assetType: 'image' as const,
      status: 'draft',
      currentLayer: 'did:peer' as const,
      didPeer: data.didPeer,
      originalReference: 'google-drive-import',
      metadata: {
        ...data.sourceMetadata,
        resourceCount: data.resources.length,
        resources: data.resources, // Only metadata (no content)
      },
      provenance: {
        didDocument: data.didDocument,
        importId: data.importId,
        resourceCount: data.resources.length,
        resources: data.resources, // Only metadata (no content)
      },
      didDocument: data.didDocument,
    };
    
    const [created] = await this.db.insert(assets).values(assetValues).returning();
    console.log(`[DatabaseStorage] Created asset ${created.id} with ${data.resources.length} resources`);
    return created;
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

  // Google Drive import methods (using in-memory for now, can be migrated to DB later)
  private googleDriveImports: Map<string, any> = new Map();

  async createGoogleDriveImport(data: {
    userId: string;
    folderId: string;
    folderName: string;
    status: string;
    totalFiles: string;
    processedFiles: string;
    failedFiles: string;
  }) {
    const id = uuidv4();
    const importRecord = {
      id,
      ...data,
      createdAt: new Date(),
      completedAt: null,
      errorDetails: [],
    };
    this.googleDriveImports.set(id, importRecord);
    return { id };
  }

  async getGoogleDriveImport(importId: string) {
    return this.googleDriveImports.get(importId);
  }

  async updateGoogleDriveImport(importId: string, updates: Partial<any>) {
    const existing = this.googleDriveImports.get(importId);
    if (existing) {
      this.googleDriveImports.set(importId, { ...existing, ...updates });
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

