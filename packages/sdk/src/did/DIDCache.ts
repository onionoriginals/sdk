import type { DIDDocument } from '../types';
import type { MetricsCollector } from '../utils/MetricsCollector';

/**
 * Configuration for the DID cache
 */
export interface DIDCacheConfig {
  /** Time-to-live in milliseconds. Default: 86400000 (24 hours) */
  ttlMs?: number;
  /** Maximum number of cached entries. Default: 1000. Uses LRU eviction. */
  maxEntries?: number;
  /** Optional persistent storage adapter */
  storage?: DIDCacheStorage;
  /** Optional metrics collector for cache hit/miss tracking */
  metrics?: MetricsCollector;
}

/**
 * Pluggable storage adapter for DID cache persistence
 */
export interface DIDCacheStorage {
  get(key: string): Promise<DIDCacheEntry | null>;
  set(key: string, entry: DIDCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

/**
 * A cached DID document entry
 */
export interface DIDCacheEntry {
  did: string;
  document: DIDDocument;
  resolvedAt: number;
  ttlMs: number;
  pinned: boolean;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * DID document cache with TTL-based expiration, LRU eviction, and pinning support.
 *
 * - Cached entries expire after a configurable TTL (default 24h)
 * - Pinned entries never expire and are not evicted
 * - When the cache is full, the least recently used unpinned entry is evicted
 * - Optional pluggable storage for offline persistence
 */
export class DIDCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly storage?: DIDCacheStorage;
  private readonly metrics?: MetricsCollector;

  /** In-memory cache: did -> entry */
  private cache = new Map<string, DIDCacheEntry>();
  /** LRU order tracking: most recent access at end */
  private accessOrder: string[] = [];

  constructor(config?: DIDCacheConfig) {
    this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.storage = config?.storage;
    this.metrics = config?.metrics;
  }

  /**
   * Load entries from persistent storage into memory.
   * Call this once at startup if using a storage adapter.
   */
  async load(): Promise<void> {
    if (!this.storage) return;
    const keys = await this.storage.keys();
    for (const key of keys) {
      const entry = await this.storage.get(key);
      if (entry && !this.isExpired(entry)) {
        this.cache.set(key, entry);
        this.touchAccessOrder(key);
      }
    }
  }

  /**
   * Get a cached DID document.
   * Returns null if not cached or expired.
   */
  async get(did: string): Promise<DIDDocument | null> {
    let entry = this.cache.get(did) ?? null;

    // Try persistent storage fallback
    if (!entry && this.storage) {
      entry = await this.storage.get(did);
      if (entry) {
        this.cache.set(did, entry);
      }
    }

    if (!entry) {
      this.metrics?.recordCacheMiss();
      return null;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(did);
      this.removeFromAccessOrder(did);
      if (this.storage) await this.storage.delete(did);
      this.metrics?.recordCacheMiss();
      return null;
    }

    this.touchAccessOrder(did);
    this.metrics?.recordCacheHit();
    return entry.document;
  }

  /**
   * Cache a resolved DID document with standard TTL.
   */
  async set(did: string, document: DIDDocument): Promise<void> {
    const entry: DIDCacheEntry = {
      did,
      document,
      resolvedAt: Date.now(),
      ttlMs: this.ttlMs,
      pinned: false,
    };

    // Check if we need to evict before adding
    if (!this.cache.has(did) && this.cache.size >= this.maxEntries) {
      await this.evictLRU();
    }

    this.cache.set(did, entry);
    this.touchAccessOrder(did);
    if (this.storage) await this.storage.set(did, entry);
  }

  /**
   * Pin a DID document so it never expires and is not evicted.
   * If no document is provided, the currently cached document is pinned.
   */
  async pin(did: string, document?: DIDDocument): Promise<void> {
    const existing = this.cache.get(did);

    if (!document && !existing) {
      throw new Error(`Cannot pin DID ${did}: not in cache and no document provided`);
    }

    const entry: DIDCacheEntry = {
      did,
      document: document ?? existing!.document,
      resolvedAt: existing?.resolvedAt ?? Date.now(),
      ttlMs: this.ttlMs,
      pinned: true,
    };

    if (!this.cache.has(did) && this.cache.size >= this.maxEntries) {
      await this.evictLRU();
    }

    this.cache.set(did, entry);
    this.touchAccessOrder(did);
    if (this.storage) await this.storage.set(did, entry);
  }

  /**
   * Unpin a DID document. It will now be subject to TTL expiration.
   * The TTL countdown restarts from the time of unpinning.
   */
  async unpin(did: string): Promise<void> {
    const entry = this.cache.get(did);
    if (!entry) return;

    entry.pinned = false;
    entry.resolvedAt = Date.now();
    if (this.storage) await this.storage.set(did, entry);
  }

  /**
   * Check if a DID is pinned.
   */
  isPinned(did: string): boolean {
    return this.cache.get(did)?.pinned ?? false;
  }

  /**
   * List all pinned DIDs.
   */
  listPinned(): string[] {
    const pinned: string[] = [];
    for (const [did, entry] of this.cache) {
      if (entry.pinned) pinned.push(did);
    }
    return pinned;
  }

  /**
   * Delete a cached DID document (including pinned).
   */
  async delete(did: string): Promise<void> {
    this.cache.delete(did);
    this.removeFromAccessOrder(did);
    if (this.storage) await this.storage.delete(did);
  }

  /**
   * Clear all cached entries.
   */
  async clear(): Promise<void> {
    this.cache.clear();
    this.accessOrder = [];
    if (this.storage) await this.storage.clear();
  }

  /**
   * Get the number of cached (non-expired) entries.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get all valid cache entries (for offline verification).
   */
  entries(): DIDCacheEntry[] {
    const result: DIDCacheEntry[] = [];
    for (const entry of this.cache.values()) {
      if (!this.isExpired(entry)) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * Check if a DID is cached and not expired.
   */
  has(did: string): boolean {
    const entry = this.cache.get(did);
    return entry != null && !this.isExpired(entry);
  }

  private isExpired(entry: DIDCacheEntry): boolean {
    if (entry.pinned) return false;
    return Date.now() - entry.resolvedAt > entry.ttlMs;
  }

  private touchAccessOrder(did: string): void {
    this.removeFromAccessOrder(did);
    this.accessOrder.push(did);
  }

  private removeFromAccessOrder(did: string): void {
    const idx = this.accessOrder.indexOf(did);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
  }

  /**
   * Evict the least recently used unpinned entry.
   */
  private async evictLRU(): Promise<void> {
    for (const did of this.accessOrder) {
      const entry = this.cache.get(did);
      if (entry && !entry.pinned) {
        this.cache.delete(did);
        this.removeFromAccessOrder(did);
        if (this.storage) await this.storage.delete(did);
        return;
      }
    }
    // All entries are pinned — cannot evict
  }
}
