// Simple PostgreSQL storage using Drizzle ORM
const { drizzle } = require("drizzle-orm/node-postgres");
const { eq, and } = require("drizzle-orm");
const { Pool } = require("pg");

// Import schema
const { users, assets, walletConnections, assetTypes } = require("../shared/schema.ts");

class DatabaseStorage {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString });
    this.db = drizzle(this.pool);
    this.signingKeys = new Map();
    this.didDocuments = new Map();
    console.log("✅ PostgreSQL DatabaseStorage initialized");
  }

  // User methods
  async getUser(id) {
    const result = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return result[0];
  }

  async getUserByUsername(username) {
    const result = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    return result[0];
  }

  async getUserByPrivyId(privyUserId) {
    const byUsername = await this.getUserByUsername(privyUserId);
    return byUsername || undefined;
  }

  async createUser(insertUser) {
    const result = await this.db.insert(users).values(insertUser).returning();
    return result[0];
  }

  async updateUser(userId, updates) {
    const result = await this.db.update(users).set(updates).where(eq(users.id, userId)).returning();
    return result[0];
  }

  async ensureUser(privyUserId) {
    const existing = await this.getUserByPrivyId(privyUserId);
    if (existing) return existing;
    return this.createUser({ username: privyUserId, password: '' });
  }

  async getUserByDidSlug(slug) {
    const result = await this.db.select().from(users).where(eq(users.didSlug, slug)).limit(1);
    return result[0];
  }

  async getUserByDid(did) {
    const result = await this.db.select().from(users).where(eq(users.did, did)).limit(1);
    return result[0];
  }

  async createUserWithDid(privyUserId, did, didData) {
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
  async getAsset(id) {
    const result = await this.db.select().from(assets).where(eq(assets.id, id)).limit(1);
    return result[0];
  }

  async getAssetsByUserId(userId, options) {
    const result = await this.db.select().from(assets).where(eq(assets.userId, userId));
    if (options?.layer && options.layer !== 'all') {
      return result.filter(asset => asset.currentLayer === options.layer);
    }
    return result;
  }

  async getAssetsByUserDid(userDid) {
    const user = await this.getUserByDid(userDid);
    if (!user) return [];
    return this.getAssetsByUserId(user.id);
  }

  async createAsset(insertAsset) {
    const result = await this.db.insert(assets).values({
      ...insertAsset,
      title: insertAsset.title || "Untitled Asset",
      status: insertAsset.status || "draft",
      assetType: insertAsset.assetType || "original",
      currentLayer: insertAsset.currentLayer || "did:peer",
    }).returning();
    return result[0];
  }

  async updateAsset(id, updates) {
    const result = await this.db.update(assets)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(assets.id, id))
      .returning();
    return result[0];
  }

  // Wallet methods
  async getWalletConnection(userId) {
    const result = await this.db.select().from(walletConnections)
      .where(and(eq(walletConnections.userId, userId), eq(walletConnections.isActive, "true")))
      .limit(1);
    return result[0];
  }

  async createWalletConnection(insertConnection) {
    const result = await this.db.insert(walletConnections).values({
      ...insertConnection,
      isActive: insertConnection.isActive || "true",
    }).returning();
    return result[0];
  }

  async updateWalletConnection(userId, updates) {
    const result = await this.db.update(walletConnections)
      .set(updates)
      .where(eq(walletConnections.userId, userId))
      .returning();
    return result[0];
  }

  // Signing keys (in-memory for security)
  async storeSigningKey(userId, key) {
    const keys = this.signingKeys.get(userId) || [];
    keys.push(key);
    this.signingKeys.set(userId, keys);
  }

  async getSigningKeys(userId) {
    return this.signingKeys.get(userId) || [];
  }

  // Asset types
  async getAssetType(id) {
    const result = await this.db.select().from(assetTypes).where(eq(assetTypes.id, id)).limit(1);
    return result[0];
  }

  async getAssetTypesByUserId(userId) {
    return this.db.select().from(assetTypes).where(eq(assetTypes.userId, userId));
  }

  async createAssetType(insertAssetType) {
    const result = await this.db.insert(assetTypes).values({
      ...insertAssetType,
      properties: insertAssetType.properties || [],
    }).returning();
    return result[0];
  }

  async updateAssetType(id, updates) {
    const result = await this.db.update(assetTypes)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(assetTypes.id, id))
      .returning();
    return result[0];
  }

  // DID documents (in-memory)
  async storeDIDDocument(slug, data) {
    this.didDocuments.set(slug, data);
  }

  async getDIDDocument(slug) {
    return this.didDocuments.get(slug);
  }

  // Stats
  async getStats() {
    const allAssets = await this.db.select().from(assets);
    return {
      totalAssets: allAssets.length,
      verifiedAssets: allAssets.filter(a => a.credentials && Object.keys(a.credentials).length > 0).length,
      migratedAssets: allAssets.filter(a => a.assetType === "migrated").length,
    };
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { DatabaseStorage };


