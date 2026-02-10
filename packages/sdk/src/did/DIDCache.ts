/**
 * DID Cache - Local caching for faster DID resolution
 * 
 * Features:
 * - TTL-based expiration (default 24 hours)
 * - Configurable max size with LRU eviction
 * - Pluggable storage adapters (memory, file, custom)
 * - Content hash verification for integrity
 * - Statistics tracking (hits, misses, evictions)
 */

import { DIDDocument } from '../types';
import * as crypto from 'crypto';

/**
 * Cached DID entry with metadata
 */
export interface DIDCacheEntry {
  did: string;
  document: DIDDocument;
  cachedAt: number;       // Unix timestamp when cached
  expiresAt: number;      // Unix timestamp when entry expires
  hash: string;           // Content hash for verification
  accessCount: number;    // Number of times accessed (for LRU)
  lastAccessedAt: number; // Last access timestamp
}

/**
 * Cache statistics for monitoring
 */
export interface DIDCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  maxSize: number;
  hitRate: number;        // hits / (hits + misses)
}

/**
 * Storage adapter interface for custom cache storage
 */
export interface DIDCacheStorage {
  get(did: string): Promise<DIDCacheEntry | null>;
  set(did: string, entry: DIDCacheEntry): Promise<void>;
  delete(did: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  size(): Promise<number>;
}

/**
 * Cache configuration options
 */
export interface DIDCacheConfig {
  /** Enable/disable caching (default: true) */
  enabled?: boolean;
  /** Time-to-live in milliseconds (default: 24 hours) */
  ttl?: number;
  /** Maximum number of DIDs to cache (default: 1000) */
  maxSize?: number;
  /** Custom storage adapter (default: in-memory) */
  storage?: DIDCacheStorage;
  /** Whether to verify content hash on retrieval (default: true) */
  verifyHash?: boolean;
  /** Auto-cache after resolution (default: true) */
  autoCacheOnResolve?: boolean;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<Omit<DIDCacheConfig, 'storage'>> = {
  enabled: true,
  ttl: 24 * 60 * 60 * 1000, // 24 hours
  maxSize: 1000,
  verifyHash: true,
  autoCacheOnResolve: true,
};

/**
 * In-memory storage implementation (default)
 */
export class MemoryDIDCacheStorage implements DIDCacheStorage {
  private cache: Map<string, DIDCacheEntry> = new Map();

  async get(did: string): Promise<DIDCacheEntry | null> {
    return this.cache.get(did) || null;
  }

  async set(did: string, entry: DIDCacheEntry): Promise<void> {
    this.cache.set(did, entry);
  }

  async delete(did: string): Promise<boolean> {
    return this.cache.delete(did);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  async keys(): Promise<string[]> {
    return Array.from(this.cache.keys());
  }

  async size(): Promise<number> {
    return this.cache.size;
  }
}

/**
 * DID Cache implementation
 * 
 * Provides local caching of resolved DID documents with:
 * - TTL-based automatic expiration
 * - LRU eviction when max size is reached
 * - Content hash verification
 * - Cache statistics for monitoring
 * 
 * @example
 * ```typescript
 * const cache = new DIDCache({ ttl: 3600000, maxSize: 500 });
 * 
 * // Cache a resolved DID
 * await cache.set('did:btco:12345', didDocument);
 * 
 * // Retrieve from cache (returns null if expired)
 * const doc = await cache.get('did:btco:12345');
 * 
 * // Check cache stats
 * const stats = cache.getStats();
 * console.log(`Hit rate: ${stats.hitRate}%`);
 * ```
 */
export class DIDCache {
  private config: Required<Omit<DIDCacheConfig, 'storage'>> & { storage: DIDCacheStorage };
  private stats: Omit<DIDCacheStats, 'size' | 'maxSize' | 'hitRate'> = {
    hits: 0,
    misses: 0,
    evictions: 0,
  };

  constructor(config: DIDCacheConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      storage: config.storage || new MemoryDIDCacheStorage(),
    };
  }

  /**
   * Check if caching is enabled
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get the configured TTL in milliseconds
   */
  get ttl(): number {
    return this.config.ttl;
  }

  /**
   * Get a cached DID document
   * Returns null if not cached, expired, or hash verification fails
   */
  async get(did: string): Promise<DIDDocument | null> {
    if (!this.config.enabled) {
      return null;
    }

    const entry = await this.config.storage.get(did);
    
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      await this.config.storage.delete(did);
      this.stats.misses++;
      return null;
    }

    // Verify content hash if enabled
    if (this.config.verifyHash) {
      const currentHash = this.computeHash(entry.document);
      if (currentHash !== entry.hash) {
        // Hash mismatch - cache corrupted, remove entry
        await this.config.storage.delete(did);
        this.stats.misses++;
        return null;
      }
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    await this.config.storage.set(did, entry);

    this.stats.hits++;
    return entry.document;
  }

  /**
   * Cache a DID document
   * Automatically handles LRU eviction if max size is reached
   */
  async set(did: string, document: DIDDocument, customTtl?: number): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // Check if this DID is already in cache (update case)
    const existing = await this.config.storage.get(did);
    
    // Check if we need to evict entries (only if adding new entry)
    if (!existing) {
      const currentSize = await this.config.storage.size();
      if (currentSize >= this.config.maxSize) {
        await this.evictLRU();
      }
    }

    const now = Date.now();
    const ttl = customTtl ?? this.config.ttl;

    const entry: DIDCacheEntry = {
      did,
      document,
      cachedAt: now,
      expiresAt: now + ttl,
      hash: this.computeHash(document),
      accessCount: 1,
      lastAccessedAt: now,
    };

    await this.config.storage.set(did, entry);
  }

  /**
   * Remove a DID from the cache
   */
  async delete(did: string): Promise<boolean> {
    return this.config.storage.delete(did);
  }

  /**
   * Clear all cached entries
   */
  async clear(): Promise<void> {
    await this.config.storage.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * Get all cached DIDs
   */
  async keys(): Promise<string[]> {
    return this.config.storage.keys();
  }

  /**
   * Check if a DID is cached (and not expired)
   */
  async has(did: string): Promise<boolean> {
    const entry = await this.config.storage.get(did);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      await this.config.storage.delete(did);
      return false;
    }
    return true;
  }

  /**
   * Get cache entry metadata without counting as a hit
   */
  async getEntry(did: string): Promise<DIDCacheEntry | null> {
    return this.config.storage.get(did);
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<DIDCacheStats> {
    const size = await this.config.storage.size();
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      size,
      maxSize: this.config.maxSize,
      hitRate: total > 0 ? (this.stats.hits / total) * 100 : 0,
    };
  }

  /**
   * Clear expired entries (garbage collection)
   */
  async clearExpired(): Promise<number> {
    const keys = await this.config.storage.keys();
    let cleared = 0;
    const now = Date.now();

    for (const did of keys) {
      const entry = await this.config.storage.get(did);
      if (entry && now > entry.expiresAt) {
        await this.config.storage.delete(did);
        cleared++;
      }
    }

    return cleared;
  }

  /**
   * Validate a cached entry against the network
   * Returns true if cache is still valid, false if outdated
   */
  async validate(did: string, currentDocument: DIDDocument): Promise<boolean> {
    const entry = await this.config.storage.get(did);
    if (!entry) return false;

    const cachedHash = entry.hash;
    const currentHash = this.computeHash(currentDocument);

    if (cachedHash !== currentHash) {
      // Cache is outdated, update it
      await this.set(did, currentDocument);
      return false;
    }

    return true;
  }

  /**
   * Refresh a cached entry's TTL without re-resolving
   */
  async refresh(did: string, customTtl?: number): Promise<boolean> {
    const entry = await this.config.storage.get(did);
    if (!entry) return false;

    const ttl = customTtl ?? this.config.ttl;
    entry.expiresAt = Date.now() + ttl;
    await this.config.storage.set(did, entry);
    return true;
  }

  /**
   * Compute content hash for a DID document
   */
  private computeHash(document: DIDDocument): string {
    // Canonical JSON serialization for consistent hashing
    const canonical = JSON.stringify(document, Object.keys(document).sort());
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Evict least recently used entry
   */
  private async evictLRU(): Promise<void> {
    const keys = await this.config.storage.keys();
    if (keys.length === 0) return;

    let lruDid: string | null = null;
    let lruTime = Infinity;

    for (const did of keys) {
      const entry = await this.config.storage.get(did);
      if (entry) {
        // First evict expired entries
        if (Date.now() > entry.expiresAt) {
          await this.config.storage.delete(did);
          this.stats.evictions++;
          return;
        }
        // Track LRU candidate
        if (entry.lastAccessedAt < lruTime) {
          lruTime = entry.lastAccessedAt;
          lruDid = did;
        }
      }
    }

    // Evict LRU entry
    if (lruDid) {
      await this.config.storage.delete(lruDid);
      this.stats.evictions++;
    }
  }
}

/**
 * Create a DID cache with default configuration
 */
export function createDIDCache(config?: DIDCacheConfig): DIDCache {
  return new DIDCache(config);
}
