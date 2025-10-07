import { type User, type InsertUser, type Asset, type InsertAsset, type WalletConnection, type InsertWalletConnection, type AssetType, type InsertAssetType, type AssetLayer } from "@shared/schema";
import { randomUUID } from "crypto";

export interface SigningKey {
  publicKey: string;
  privateKey: string;
  publicKeyHex: string;
  algorithm: string;
  createdAt: string;
}

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByPrivyId(privyUserId: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(userId: string, updates: Partial<User>): Promise<User | undefined>;
  ensureUser(userId: string): Promise<User>;
  getUserByDidSlug(slug: string): Promise<User | undefined>;
  getUserByDid(did: string): Promise<User | undefined>;
  createUserWithDid(privyUserId: string, did: string, didData: any): Promise<User>;
  
  // Asset methods
  getAsset(id: string): Promise<Asset | undefined>;
  getAssetsByUserId(userId: string, options?: { layer?: string }): Promise<Asset[]>;
  getAssetsByUserDid(userDid: string): Promise<Asset[]>;
  createAsset(asset: InsertAsset): Promise<Asset>;
  updateAsset(id: string, updates: Partial<Asset>): Promise<Asset | undefined>;
  
  // Wallet connection methods
  getWalletConnection(userId: string): Promise<WalletConnection | undefined>;
  createWalletConnection(connection: InsertWalletConnection): Promise<WalletConnection>;
  updateWalletConnection(userId: string, updates: Partial<WalletConnection>): Promise<WalletConnection | undefined>;
  
  // Signing key methods
  storeSigningKey(userId: string, key: SigningKey): Promise<void>;
  getSigningKeys(userId: string): Promise<SigningKey[]>;
  
  // Asset type methods
  getAssetType(id: string): Promise<AssetType | undefined>;
  getAssetTypesByUserId(userId: string): Promise<AssetType[]>;
  createAssetType(assetType: InsertAssetType): Promise<AssetType>;
  updateAssetType(id: string, updates: Partial<AssetType>): Promise<AssetType | undefined>;
  
  // DID document methods
  storeDIDDocument(slug: string, data: { didDocument: any; didLog?: any; publishedAt: string }): Promise<void>;
  getDIDDocument(slug: string): Promise<{ didDocument: any; didLog?: any; publishedAt: string } | undefined>;
  
  // Statistics
  getStats(): Promise<{
    totalAssets: number;
    verifiedAssets: number;
    migratedAssets: number;
  }>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>; // Key: did:webvh, Value: User
  private privyToDidMapping: Map<string, string>; // Key: Privy user ID, Value: did:webvh
  private assets: Map<string, Asset>;
  private walletConnections: Map<string, WalletConnection>;
  private signingKeys: Map<string, SigningKey[]>;
  private assetTypes: Map<string, AssetType>;
  private didDocuments: Map<string, { didDocument: any; didLog?: any; publishedAt: string }>;

  constructor() {
    this.users = new Map();
    this.privyToDidMapping = new Map();
    this.assets = new Map();
    this.walletConnections = new Map();
    this.signingKeys = new Map();
    this.assetTypes = new Map();
    this.didDocuments = new Map();
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async getUserByPrivyId(privyUserId: string): Promise<User | undefined> {
    const did = this.privyToDidMapping.get(privyUserId);
    if (!did) return undefined;
    return this.users.get(did);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { 
      ...insertUser, 
      id,
      did: null,
      didDocument: null,
      didLog: null,
      didSlug: null,
      authWalletId: null,
      assertionWalletId: null,
      updateWalletId: null,
      authKeyPublic: null,
      assertionKeyPublic: null,
      updateKeyPublic: null,
      didCreatedAt: null,
    };
    this.users.set(id, user);
    return user;
  }

  async updateUser(userId: string, updates: Partial<User>): Promise<User | undefined> {
    const user = this.users.get(userId);
    if (!user) return undefined;

    const updatedUser = { ...user, ...updates };
    this.users.set(userId, updatedUser);
    return updatedUser;
  }

  async ensureUser(privyUserId: string): Promise<User> {
    // Check if user already exists by Privy ID
    const existing = await this.getUserByPrivyId(privyUserId);
    if (existing) {
      return existing;
    }

    // Create a temporary user record with Privy ID - DID will be added later
    const user: User = {
      id: privyUserId, // Temporary - will be updated to DID
      username: privyUserId,
      password: '', // Not used for Privy users
      did: null,
      didDocument: null,
      didLog: null,
      didSlug: null,
      authWalletId: null,
      assertionWalletId: null,
      updateWalletId: null,
      authKeyPublic: null,
      assertionKeyPublic: null,
      updateKeyPublic: null,
      didCreatedAt: null,
    };
    this.users.set(privyUserId, user);
    return user;
  }

  async createUserWithDid(privyUserId: string, did: string, didData: any): Promise<User> {
    // Create user with DID as the primary key
    const user: User = {
      id: did, // Use DID as primary identifier
      username: did,
      password: '', // Not used for Privy users
      did: did,
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
    };
    
    // Store user with DID as key
    this.users.set(did, user);
    
    // Create mapping from Privy ID to DID
    this.privyToDidMapping.set(privyUserId, did);
    
    // Remove temporary user record if it exists
    this.users.delete(privyUserId);
    
    return user;
  }

  async getUserByDidSlug(slug: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.did && user.did.endsWith(`:${slug}`)
    );
  }

  async getUserByDid(did: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.did === did
    );
  }

  async getAsset(id: string): Promise<Asset | undefined> {
    return this.assets.get(id);
  }

  async getAssetsByUserId(userId: string, options?: { layer?: string }): Promise<Asset[]> {
    let assets = Array.from(this.assets.values()).filter(
      (asset) => asset.userId === userId,
    );
    
    // Filter by layer if specified
    if (options?.layer && options.layer !== 'all') {
      assets = assets.filter(asset => asset.currentLayer === options.layer);
    }
    
    return assets;
  }

  async getAssetsByUserDid(userDid: string): Promise<Asset[]> {
    // Find the user by their DID to get their internal ID
    const user = await this.getUserByDid(userDid);
    if (!user) return [];
    
    // Use the internal user ID to find assets
    return this.getAssetsByUserId(user.id);
  }

  async createAsset(insertAsset: InsertAsset): Promise<Asset> {
    const id = `orig_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const asset: Asset = {
      ...insertAsset,
      id,
      userId: insertAsset.userId || null,
      title: insertAsset.title || "Untitled Asset",
      description: insertAsset.description || null,
      category: insertAsset.category || null,
      tags: insertAsset.tags || [],
      mediaUrl: insertAsset.mediaUrl || null,
      metadata: insertAsset.metadata || null,
      credentials: insertAsset.credentials || null,
      status: insertAsset.status || "draft",
      assetType: insertAsset.assetType || "original",
      originalReference: insertAsset.originalReference || null,
      // Layer tracking fields - now properly typed!
      currentLayer: insertAsset.currentLayer || "did:peer",
      didPeer: insertAsset.didPeer || null,
      didWebvh: insertAsset.didWebvh || null,
      didBtco: insertAsset.didBtco || null,
      provenance: insertAsset.provenance || null,
      didDocument: insertAsset.didDocument || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.assets.set(id, asset);
    return asset;
  }

  async updateAsset(id: string, updates: Partial<Asset>): Promise<Asset | undefined> {
    const asset = this.assets.get(id);
    if (!asset) return undefined;

    const updatedAsset = { ...asset, ...updates, updatedAt: new Date() };
    this.assets.set(id, updatedAsset);
    return updatedAsset;
  }

  async getWalletConnection(userId: string): Promise<WalletConnection | undefined> {
    return Array.from(this.walletConnections.values()).find(
      (connection) => connection.userId === userId && connection.isActive === "true",
    );
  }

  async createWalletConnection(insertConnection: InsertWalletConnection): Promise<WalletConnection> {
    const id = randomUUID();
    const connection: WalletConnection = {
      ...insertConnection,
      id,
      userId: insertConnection.userId || null,
      isActive: insertConnection.isActive || "true",
      createdAt: new Date(),
    };
    this.walletConnections.set(id, connection);
    return connection;
  }

  async updateWalletConnection(userId: string, updates: Partial<WalletConnection>): Promise<WalletConnection | undefined> {
    const connection = Array.from(this.walletConnections.values()).find(
      (conn) => conn.userId === userId,
    );
    if (!connection) return undefined;

    const updatedConnection = { ...connection, ...updates };
    this.walletConnections.set(connection.id, updatedConnection);
    return updatedConnection;
  }

  async storeSigningKey(userId: string, key: SigningKey): Promise<void> {
    const userKeys = this.signingKeys.get(userId) || [];
    userKeys.push(key);
    this.signingKeys.set(userId, userKeys);
  }

  async getSigningKeys(userId: string): Promise<SigningKey[]> {
    return this.signingKeys.get(userId) || [];
  }

  async getAssetType(id: string): Promise<AssetType | undefined> {
    return this.assetTypes.get(id);
  }

  async getAssetTypesByUserId(userId: string): Promise<AssetType[]> {
    return Array.from(this.assetTypes.values()).filter(
      (assetType) => assetType.userId === userId,
    );
  }

  async createAssetType(insertAssetType: InsertAssetType): Promise<AssetType> {
    const id = randomUUID();
    const assetType: AssetType = {
      ...insertAssetType,
      id,
      userId: insertAssetType.userId || null,
      description: insertAssetType.description || null,
      properties: insertAssetType.properties || [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.assetTypes.set(id, assetType);
    return assetType;
  }

  async updateAssetType(id: string, updates: Partial<AssetType>): Promise<AssetType | undefined> {
    const assetType = this.assetTypes.get(id);
    if (!assetType) return undefined;

    const updatedAssetType = { ...assetType, ...updates, updatedAt: new Date() };
    this.assetTypes.set(id, updatedAssetType);
    return updatedAssetType;
  }

  async storeDIDDocument(slug: string, data: { didDocument: any; didLog?: any; publishedAt: string }): Promise<void> {
    this.didDocuments.set(slug, data);
  }

  async getDIDDocument(slug: string): Promise<{ didDocument: any; didLog?: any; publishedAt: string } | undefined> {
    return this.didDocuments.get(slug);
  }

  async getStats(): Promise<{ totalAssets: number; verifiedAssets: number; migratedAssets: number; }> {
    const allAssets = Array.from(this.assets.values());
    return {
      totalAssets: allAssets.length,
      verifiedAssets: allAssets.filter(asset => asset.credentials && Object.keys(asset.credentials as any).length > 0).length,
      migratedAssets: allAssets.filter(asset => asset.assetType === "migrated").length,
    };
  }
}

export const storage = new MemStorage();
