import { type User, type InsertUser, type Asset, type InsertAsset, type WalletConnection, type InsertWalletConnection } from "@shared/schema";
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
  createUser(user: InsertUser): Promise<User>;
  updateUser(userId: string, updates: Partial<User>): Promise<User | undefined>;
  ensureUser(userId: string): Promise<User>;
  getUserByDidSlug(slug: string): Promise<User | undefined>;
  getUserByDid(did: string): Promise<User | undefined>;
  
  // Asset methods
  getAsset(id: string): Promise<Asset | undefined>;
  getAssetsByUserId(userId: string): Promise<Asset[]>;
  createAsset(asset: InsertAsset): Promise<Asset>;
  updateAsset(id: string, updates: Partial<Asset>): Promise<Asset | undefined>;
  
  // Wallet connection methods
  getWalletConnection(userId: string): Promise<WalletConnection | undefined>;
  createWalletConnection(connection: InsertWalletConnection): Promise<WalletConnection>;
  updateWalletConnection(userId: string, updates: Partial<WalletConnection>): Promise<WalletConnection | undefined>;
  
  // Signing key methods
  storeSigningKey(userId: string, key: SigningKey): Promise<void>;
  getSigningKeys(userId: string): Promise<SigningKey[]>;
  
  // Statistics
  getStats(): Promise<{
    totalAssets: number;
    verifiedAssets: number;
    migratedAssets: number;
  }>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private assets: Map<string, Asset>;
  private walletConnections: Map<string, WalletConnection>;
  private signingKeys: Map<string, SigningKey[]>;

  constructor() {
    this.users = new Map();
    this.assets = new Map();
    this.walletConnections = new Map();
    this.signingKeys = new Map();
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { 
      ...insertUser, 
      id,
      did: null,
      didDocument: null,
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

  async ensureUser(userId: string): Promise<User> {
    // Check if user already exists
    const existing = this.users.get(userId);
    if (existing) {
      return existing;
    }

    // Create a new user with Privy ID as both id and username
    const user: User = {
      id: userId,
      username: userId,
      password: '', // Not used for Privy users
      did: null,
      didDocument: null,
      authWalletId: null,
      assertionWalletId: null,
      updateWalletId: null,
      authKeyPublic: null,
      assertionKeyPublic: null,
      updateKeyPublic: null,
      didCreatedAt: null,
    };
    this.users.set(userId, user);
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

  async getAssetsByUserId(userId: string): Promise<Asset[]> {
    return Array.from(this.assets.values()).filter(
      (asset) => asset.userId === userId,
    );
  }

  async createAsset(insertAsset: InsertAsset): Promise<Asset> {
    const id = `orig_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const asset: Asset = {
      ...insertAsset,
      id,
      description: insertAsset.description || null,
      category: insertAsset.category || null,
      tags: insertAsset.tags || null,
      mediaUrl: insertAsset.mediaUrl || null,
      metadata: insertAsset.metadata || null,
      credentials: insertAsset.credentials || null,
      originalReference: insertAsset.originalReference || null,
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
