import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DIDCache, MemoryDIDCacheStorage, DIDCacheEntry, DIDCacheStorage } from '../../src/did/DIDCache';
import { DIDDocument } from '../../src/types';

describe('DIDCache', () => {
  let cache: DIDCache;

  const sampleDoc: DIDDocument = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: 'did:btco:123456',
    verificationMethod: [
      {
        id: 'did:btco:123456#key-0',
        type: 'Multikey',
        controller: 'did:btco:123456',
        publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      },
    ],
    authentication: ['did:btco:123456#key-0'],
    assertionMethod: ['did:btco:123456#key-0'],
  };

  beforeEach(() => {
    cache = new DIDCache({ enabled: true, ttl: 60000, maxSize: 10 });
  });

  afterEach(async () => {
    await cache.clear();
  });

  describe('basic operations', () => {
    it('should cache and retrieve a DID document', async () => {
      await cache.set('did:btco:123456', sampleDoc);
      const retrieved = await cache.get('did:btco:123456');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe('did:btco:123456');
    });

    it('should return null for non-existent DID', async () => {
      const retrieved = await cache.get('did:btco:nonexistent');
      expect(retrieved).toBeNull();
    });

    it('should delete a cached DID', async () => {
      await cache.set('did:btco:123456', sampleDoc);
      const deleted = await cache.delete('did:btco:123456');
      expect(deleted).toBe(true);

      const retrieved = await cache.get('did:btco:123456');
      expect(retrieved).toBeNull();
    });

    it('should clear all cached DIDs', async () => {
      await cache.set('did:btco:1', sampleDoc);
      await cache.set('did:btco:2', { ...sampleDoc, id: 'did:btco:2' });
      await cache.set('did:btco:3', { ...sampleDoc, id: 'did:btco:3' });

      await cache.clear();

      const keys = await cache.keys();
      expect(keys.length).toBe(0);
    });

    it('should check if DID is cached', async () => {
      await cache.set('did:btco:123456', sampleDoc);

      expect(await cache.has('did:btco:123456')).toBe(true);
      expect(await cache.has('did:btco:nonexistent')).toBe(false);
    });

    it('should list all cached DIDs', async () => {
      await cache.set('did:btco:1', sampleDoc);
      await cache.set('did:btco:2', { ...sampleDoc, id: 'did:btco:2' });

      const keys = await cache.keys();
      expect(keys.length).toBe(2);
      expect(keys).toContain('did:btco:1');
      expect(keys).toContain('did:btco:2');
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', async () => {
      const shortTtlCache = new DIDCache({ enabled: true, ttl: 50 }); // 50ms TTL

      await shortTtlCache.set('did:btco:expiring', sampleDoc);
      
      // Should be available immediately
      let retrieved = await shortTtlCache.get('did:btco:expiring');
      expect(retrieved).not.toBeNull();

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should be expired now
      retrieved = await shortTtlCache.get('did:btco:expiring');
      expect(retrieved).toBeNull();
    });

    it('should support custom TTL per entry', async () => {
      // Set with custom TTL of 50ms
      await cache.set('did:btco:short', sampleDoc, 50);
      // Set with default TTL
      await cache.set('did:btco:long', { ...sampleDoc, id: 'did:btco:long' });

      // Wait for short TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Short TTL entry should be expired
      expect(await cache.get('did:btco:short')).toBeNull();
      // Long TTL entry should still be valid
      expect(await cache.get('did:btco:long')).not.toBeNull();
    });

    it('should clear expired entries', async () => {
      const shortTtlCache = new DIDCache({ enabled: true, ttl: 50 });

      await shortTtlCache.set('did:btco:1', sampleDoc);
      await shortTtlCache.set('did:btco:2', { ...sampleDoc, id: 'did:btco:2' });

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      const cleared = await shortTtlCache.clearExpired();
      expect(cleared).toBe(2);
    });
  });

  describe('LRU eviction', () => {
    it('should evict least recently used when max size reached', async () => {
      const smallCache = new DIDCache({ enabled: true, maxSize: 3 });

      // Fill cache with delays to ensure different timestamps
      await smallCache.set('did:btco:1', { ...sampleDoc, id: 'did:btco:1' });
      await new Promise((r) => setTimeout(r, 10));
      await smallCache.set('did:btco:2', { ...sampleDoc, id: 'did:btco:2' });
      await new Promise((r) => setTimeout(r, 10));
      await smallCache.set('did:btco:3', { ...sampleDoc, id: 'did:btco:3' });
      await new Promise((r) => setTimeout(r, 10));

      // Access first entry to make it recently used
      await smallCache.get('did:btco:1');
      await new Promise((r) => setTimeout(r, 10));

      // Add new entry - should evict did:btco:2 (LRU)
      await smallCache.set('did:btco:4', { ...sampleDoc, id: 'did:btco:4' });

      // did:btco:2 should be evicted (it was least recently used)
      expect(await smallCache.has('did:btco:2')).toBe(false);
      // Others should still exist
      expect(await smallCache.has('did:btco:1')).toBe(true);
      expect(await smallCache.has('did:btco:3')).toBe(true);
      expect(await smallCache.has('did:btco:4')).toBe(true);
    });
  });

  describe('cache statistics', () => {
    it('should track hits and misses', async () => {
      await cache.set('did:btco:123456', sampleDoc);

      // Hit
      await cache.get('did:btco:123456');
      // Miss
      await cache.get('did:btco:nonexistent');
      // Another hit
      await cache.get('did:btco:123456');

      const stats = await cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(66.67, 1);
    });

    it('should track cache size', async () => {
      await cache.set('did:btco:1', sampleDoc);
      await cache.set('did:btco:2', { ...sampleDoc, id: 'did:btco:2' });

      const stats = await cache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(10);
    });
  });

  describe('hash verification', () => {
    it('should verify content hash on retrieval', async () => {
      const verifyCache = new DIDCache({ enabled: true, verifyHash: true });
      await verifyCache.set('did:btco:123456', sampleDoc);

      // Retrieve should succeed with valid hash
      const retrieved = await verifyCache.get('did:btco:123456');
      expect(retrieved).not.toBeNull();
    });

    it('should detect corrupted cache entries', async () => {
      // Create a custom storage that can be manipulated
      const storage = new MemoryDIDCacheStorage();
      const verifyCache = new DIDCache({ enabled: true, verifyHash: true, storage });

      await verifyCache.set('did:btco:123456', sampleDoc);

      // Corrupt the cached entry
      const entry = await storage.get('did:btco:123456');
      if (entry) {
        entry.document.id = 'did:btco:corrupted'; // Change the document
        // But keep the old hash - this should fail verification
        await storage.set('did:btco:123456', entry);
      }

      // Retrieval should fail due to hash mismatch
      const retrieved = await verifyCache.get('did:btco:123456');
      expect(retrieved).toBeNull();
    });
  });

  describe('disabled cache', () => {
    it('should return null when cache is disabled', async () => {
      const disabledCache = new DIDCache({ enabled: false });

      await disabledCache.set('did:btco:123456', sampleDoc);
      const retrieved = await disabledCache.get('did:btco:123456');

      expect(retrieved).toBeNull();
    });
  });

  describe('refresh and validate', () => {
    it('should refresh TTL without re-resolving', async () => {
      const shortCache = new DIDCache({ enabled: true, ttl: 100 });
      await shortCache.set('did:btco:123456', sampleDoc);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Refresh with new TTL
      const refreshed = await shortCache.refresh('did:btco:123456', 200);
      expect(refreshed).toBe(true);

      // Wait past original TTL
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still be valid due to refresh
      const retrieved = await shortCache.get('did:btco:123456');
      expect(retrieved).not.toBeNull();
    });

    it('should validate cache against network document', async () => {
      await cache.set('did:btco:123456', sampleDoc);

      // Same document - should be valid
      const valid = await cache.validate('did:btco:123456', sampleDoc);
      expect(valid).toBe(true);

      // Different document - should be invalid and update cache
      const updatedDoc = { ...sampleDoc, service: [{ id: 'new-service', type: 'test' }] };
      const invalid = await cache.validate('did:btco:123456', updatedDoc);
      expect(invalid).toBe(false);

      // Cache should now have updated document
      const retrieved = await cache.get('did:btco:123456');
      expect(retrieved?.service).toBeDefined();
    });
  });

  describe('entry metadata', () => {
    it('should track access count and timestamps', async () => {
      await cache.set('did:btco:123456', sampleDoc);

      // Access multiple times
      await cache.get('did:btco:123456');
      await cache.get('did:btco:123456');
      await cache.get('did:btco:123456');

      const entry = await cache.getEntry('did:btco:123456');
      expect(entry).not.toBeNull();
      expect(entry?.accessCount).toBe(4); // 1 initial + 3 gets
      expect(entry?.cachedAt).toBeLessThanOrEqual(entry?.lastAccessedAt || 0);
    });
  });
});

describe('MemoryDIDCacheStorage', () => {
  let storage: MemoryDIDCacheStorage;

  beforeEach(() => {
    storage = new MemoryDIDCacheStorage();
  });

  it('should implement DIDCacheStorage interface', async () => {
    const entry: DIDCacheEntry = {
      did: 'did:btco:123',
      document: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:123' },
      cachedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      hash: 'abc123',
      accessCount: 1,
      lastAccessedAt: Date.now(),
    };

    await storage.set('did:btco:123', entry);
    expect(await storage.size()).toBe(1);

    const retrieved = await storage.get('did:btco:123');
    expect(retrieved).toEqual(entry);

    const keys = await storage.keys();
    expect(keys).toContain('did:btco:123');

    await storage.delete('did:btco:123');
    expect(await storage.size()).toBe(0);

    await storage.set('did:btco:123', entry);
    await storage.clear();
    expect(await storage.size()).toBe(0);
  });
});
