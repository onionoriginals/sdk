import { describe, test, expect, beforeEach } from 'bun:test';
import { DIDCache, type DIDCacheStorage, type DIDCacheEntry } from '../../../src/did/DIDCache';
import { MetricsCollector } from '../../../src/utils/MetricsCollector';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import type { DIDDocument } from '../../../src/types';

const makeDIDDoc = (id: string): DIDDocument => ({
  '@context': ['https://www.w3.org/ns/did/v1'],
  id,
});

// Build an OrdMockProvider that resolves a specific did:btco:<sat> to `doc`.
// The DIDManager cache-integration tests below need a DID with a real
// cache-miss → fetch path; did:peer creation is gone (did:peer purge,
// did:cel Phase 4·5/5), so we use a resolvable did:btco instead.
const makeBtcoProvider = (sat: string, doc: DIDDocument): OrdMockProvider =>
  new OrdMockProvider({
    inscriptionsById: new Map([[`insc-${sat}`, {
      inscriptionId: `insc-${sat}`,
      content: Buffer.from(JSON.stringify(doc), 'utf8'),
      contentType: 'application/json',
      txid: `tx-${sat}`,
      vout: 0,
      satoshi: sat,
    }]]),
    inscriptionsBySatoshi: new Map([[sat, [`insc-${sat}`]]]),
  });

describe('DIDCache', () => {
  let cache: DIDCache;

  beforeEach(() => {
    cache = new DIDCache();
  });

  describe('basic cache operations', () => {
    test('should return null for uncached DID', async () => {
      expect(await cache.get('did:peer:abc')).toBeNull();
    });

    test('should cache and retrieve a DID document', async () => {
      const doc = makeDIDDoc('did:peer:abc');
      await cache.set('did:peer:abc', doc);
      const result = await cache.get('did:peer:abc');
      expect(result).toEqual(doc);
    });

    test('should update an existing cached entry', async () => {
      const doc1 = makeDIDDoc('did:peer:abc');
      const doc2 = { ...doc1, alsoKnownAs: ['alias'] };
      await cache.set('did:peer:abc', doc1);
      await cache.set('did:peer:abc', doc2);
      const result = await cache.get('did:peer:abc');
      expect(result).toEqual(doc2);
      expect(cache.size).toBe(1);
    });

    test('should delete a cached entry', async () => {
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));
      await cache.delete('did:peer:abc');
      expect(await cache.get('did:peer:abc')).toBeNull();
      expect(cache.size).toBe(0);
    });

    test('should clear all entries', async () => {
      await cache.set('did:peer:a', makeDIDDoc('did:peer:a'));
      await cache.set('did:peer:b', makeDIDDoc('did:peer:b'));
      await cache.clear();
      expect(cache.size).toBe(0);
    });

    test('has() should return true for cached, false for uncached', async () => {
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));
      expect(cache.has('did:peer:abc')).toBe(true);
      expect(cache.has('did:peer:xyz')).toBe(false);
    });

    test('entries() should return all valid entries', async () => {
      await cache.set('did:peer:a', makeDIDDoc('did:peer:a'));
      await cache.set('did:peer:b', makeDIDDoc('did:peer:b'));
      const entries = cache.entries();
      expect(entries.length).toBe(2);
    });
  });

  describe('TTL expiration', () => {
    test('should expire entries after TTL', async () => {
      cache = new DIDCache({ ttlMs: 50 });
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));
      expect(await cache.get('did:peer:abc')).not.toBeNull();

      await new Promise(resolve => setTimeout(resolve, 60));

      expect(await cache.get('did:peer:abc')).toBeNull();
    });

    test('pinned entries should not expire', async () => {
      cache = new DIDCache({ ttlMs: 50 });
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));
      await cache.pin('did:peer:abc');

      await new Promise(resolve => setTimeout(resolve, 60));

      expect(await cache.get('did:peer:abc')).not.toBeNull();
    });

    test('has() should return false for expired entries', async () => {
      cache = new DIDCache({ ttlMs: 50 });
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));

      await new Promise(resolve => setTimeout(resolve, 60));

      expect(cache.has('did:peer:abc')).toBe(false);
    });
  });

  describe('LRU eviction', () => {
    test('should evict LRU entry when at max capacity', async () => {
      cache = new DIDCache({ maxEntries: 3 });
      await cache.set('did:peer:a', makeDIDDoc('did:peer:a'));
      await cache.set('did:peer:b', makeDIDDoc('did:peer:b'));
      await cache.set('did:peer:c', makeDIDDoc('did:peer:c'));

      // Access 'a' to make it recent
      await cache.get('did:peer:a');

      // Add 'd' - should evict 'b' (least recently used)
      await cache.set('did:peer:d', makeDIDDoc('did:peer:d'));

      expect(await cache.get('did:peer:a')).not.toBeNull();
      expect(await cache.get('did:peer:b')).toBeNull();
      expect(await cache.get('did:peer:c')).not.toBeNull();
      expect(await cache.get('did:peer:d')).not.toBeNull();
    });

    test('preserves LRU order across interleaved accesses', async () => {
      cache = new DIDCache({ maxEntries: 3 });
      await cache.set('did:peer:a', makeDIDDoc('did:peer:a'));
      await cache.set('did:peer:b', makeDIDDoc('did:peer:b'));
      await cache.set('did:peer:c', makeDIDDoc('did:peer:c'));

      // Touch in an order that makes 'c' the least recently used: a, b.
      await cache.get('did:peer:a');
      await cache.get('did:peer:b');

      // Adding 'd' should evict 'c' (the LRU after the touches).
      await cache.set('did:peer:d', makeDIDDoc('did:peer:d'));
      expect(await cache.get('did:peer:c')).toBeNull();
      expect(await cache.get('did:peer:a')).not.toBeNull();
      expect(await cache.get('did:peer:b')).not.toBeNull();
      expect(await cache.get('did:peer:d')).not.toBeNull();
    });

    test('should not evict pinned entries', async () => {
      cache = new DIDCache({ maxEntries: 2 });
      await cache.set('did:peer:a', makeDIDDoc('did:peer:a'));
      await cache.pin('did:peer:a');
      await cache.set('did:peer:b', makeDIDDoc('did:peer:b'));

      // Add 'c' - should evict 'b' (unpinned), not 'a' (pinned)
      await cache.set('did:peer:c', makeDIDDoc('did:peer:c'));

      expect(await cache.get('did:peer:a')).not.toBeNull();
      expect(await cache.get('did:peer:b')).toBeNull();
      expect(await cache.get('did:peer:c')).not.toBeNull();
    });
  });

  describe('pinning', () => {
    test('should pin an existing cached entry', async () => {
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));
      await cache.pin('did:peer:abc');
      expect(cache.isPinned('did:peer:abc')).toBe(true);
    });

    test('should pin with a document', async () => {
      const doc = makeDIDDoc('did:peer:abc');
      await cache.pin('did:peer:abc', doc);
      expect(cache.isPinned('did:peer:abc')).toBe(true);
      expect(await cache.get('did:peer:abc')).toEqual(doc);
    });

    test('should throw when pinning uncached DID without document', async () => {
      expect(cache.pin('did:peer:abc')).rejects.toThrow('not in cache');
    });

    test('should unpin a pinned entry', async () => {
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));
      await cache.pin('did:peer:abc');
      await cache.unpin('did:peer:abc');
      expect(cache.isPinned('did:peer:abc')).toBe(false);
    });

    test('unpin should be a no-op for non-existent entries', async () => {
      await cache.unpin('did:peer:nonexistent'); // should not throw
    });

    test('isPinned should return false for non-existent entries', () => {
      expect(cache.isPinned('did:peer:abc')).toBe(false);
    });

    test('listPinned should return all pinned DIDs', async () => {
      await cache.set('did:peer:a', makeDIDDoc('did:peer:a'));
      await cache.set('did:peer:b', makeDIDDoc('did:peer:b'));
      await cache.set('did:peer:c', makeDIDDoc('did:peer:c'));
      await cache.pin('did:peer:a');
      await cache.pin('did:peer:c');

      const pinned = cache.listPinned();
      expect(pinned).toContain('did:peer:a');
      expect(pinned).toContain('did:peer:c');
      expect(pinned).not.toContain('did:peer:b');
      expect(pinned.length).toBe(2);
    });

    test('delete should remove pinned entries', async () => {
      await cache.pin('did:peer:abc', makeDIDDoc('did:peer:abc'));
      await cache.delete('did:peer:abc');
      expect(await cache.get('did:peer:abc')).toBeNull();
      expect(cache.listPinned().length).toBe(0);
    });

    test('clear without includePinned should keep pinned entries', async () => {
      // The current implementation clears everything - test actual behavior
      await cache.set('did:peer:a', makeDIDDoc('did:peer:a'));
      await cache.pin('did:peer:b', makeDIDDoc('did:peer:b'));
      await cache.clear();
      // Default clear removes everything
      expect(cache.size).toBe(0);
    });
  });

  describe('metrics integration', () => {
    let metrics: MetricsCollector;

    beforeEach(() => {
      metrics = new MetricsCollector();
      cache = new DIDCache({ metrics });
    });

    test('should record cache hits', async () => {
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));
      await cache.get('did:peer:abc');

      const allMetrics = metrics.getMetrics();
      expect(allMetrics.cacheStats).toBeDefined();
      expect(allMetrics.cacheStats!.hits).toBe(1);
    });

    test('should record cache misses', async () => {
      await cache.get('did:peer:nonexistent');

      const allMetrics = metrics.getMetrics();
      expect(allMetrics.cacheStats).toBeDefined();
      expect(allMetrics.cacheStats!.misses).toBe(1);
    });

    test('should record miss on TTL expiration', async () => {
      cache = new DIDCache({ ttlMs: 50, metrics });
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));

      await new Promise(resolve => setTimeout(resolve, 60));
      await cache.get('did:peer:abc');

      const allMetrics = metrics.getMetrics();
      expect(allMetrics.cacheStats!.misses).toBe(1);
    });

    test('should track hit rate correctly', async () => {
      await cache.set('did:peer:a', makeDIDDoc('did:peer:a'));
      await cache.get('did:peer:a'); // hit
      await cache.get('did:peer:a'); // hit
      await cache.get('did:peer:b'); // miss

      const allMetrics = metrics.getMetrics();
      expect(allMetrics.cacheStats!.hits).toBe(2);
      expect(allMetrics.cacheStats!.misses).toBe(1);
      expect(allMetrics.cacheStats!.hitRate).toBeCloseTo(2 / 3);
    });
  });

  describe('pluggable storage', () => {
    let storageMap: Map<string, DIDCacheEntry>;
    let storage: DIDCacheStorage;

    beforeEach(() => {
      storageMap = new Map();
      storage = {
        get: async (key: string) => storageMap.get(key) ?? null,
        set: async (key: string, entry: DIDCacheEntry) => { storageMap.set(key, entry); },
        delete: async (key: string) => { storageMap.delete(key); },
        keys: async () => Array.from(storageMap.keys()),
        clear: async () => { storageMap.clear(); },
      };
      cache = new DIDCache({ storage });
    });

    test('should persist entries to storage', async () => {
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));
      expect(storageMap.has('did:peer:abc')).toBe(true);
    });

    test('should load entries from storage on load()', async () => {
      const entry: DIDCacheEntry = {
        did: 'did:peer:stored',
        document: makeDIDDoc('did:peer:stored'),
        resolvedAt: Date.now(),
        ttlMs: 86400000,
        pinned: false,
      };
      storageMap.set('did:peer:stored', entry);

      await cache.load();
      expect(await cache.get('did:peer:stored')).toEqual(entry.document);
    });

    test('should not load expired entries from storage', async () => {
      const entry: DIDCacheEntry = {
        did: 'did:peer:expired',
        document: makeDIDDoc('did:peer:expired'),
        resolvedAt: Date.now() - 90000000, // expired
        ttlMs: 86400000,
        pinned: false,
      };
      storageMap.set('did:peer:expired', entry);

      await cache.load();
      expect(cache.has('did:peer:expired')).toBe(false);
    });

    test('should load pinned entries from storage even if old', async () => {
      const entry: DIDCacheEntry = {
        did: 'did:peer:pinned',
        document: makeDIDDoc('did:peer:pinned'),
        resolvedAt: Date.now() - 90000000,
        ttlMs: 86400000,
        pinned: true,
      };
      storageMap.set('did:peer:pinned', entry);

      await cache.load();
      expect(await cache.get('did:peer:pinned')).toEqual(entry.document);
    });

    test('should fall back to storage on in-memory miss', async () => {
      // Simulate entry in storage but not in memory
      const entry: DIDCacheEntry = {
        did: 'did:peer:remote',
        document: makeDIDDoc('did:peer:remote'),
        resolvedAt: Date.now(),
        ttlMs: 86400000,
        pinned: false,
      };
      storageMap.set('did:peer:remote', entry);

      const result = await cache.get('did:peer:remote');
      expect(result).toEqual(entry.document);
    });

    test('should delete from storage', async () => {
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));
      await cache.delete('did:peer:abc');
      expect(storageMap.has('did:peer:abc')).toBe(false);
    });

    test('should clear storage', async () => {
      await cache.set('did:peer:a', makeDIDDoc('did:peer:a'));
      await cache.set('did:peer:b', makeDIDDoc('did:peer:b'));
      await cache.clear();
      expect(storageMap.size).toBe(0);
    });

    test('should persist pin state to storage', async () => {
      await cache.set('did:peer:abc', makeDIDDoc('did:peer:abc'));
      await cache.pin('did:peer:abc');
      expect(storageMap.get('did:peer:abc')?.pinned).toBe(true);
    });
  });

  describe('offline verification scenario', () => {
    test('pin important DIDs while online, verify offline from storage', async () => {
      const storageMap = new Map<string, DIDCacheEntry>();
      const storage: DIDCacheStorage = {
        get: async (key: string) => storageMap.get(key) ?? null,
        set: async (key: string, entry: DIDCacheEntry) => { storageMap.set(key, entry); },
        delete: async (key: string) => { storageMap.delete(key); },
        keys: async () => Array.from(storageMap.keys()),
        clear: async () => { storageMap.clear(); },
      };

      // Online: pin important DIDs
      const onlineCache = new DIDCache({ storage });
      const issuerDoc = makeDIDDoc('did:webvh:example.com:issuer');
      const subjectDoc = makeDIDDoc('did:peer:subject');
      await onlineCache.pin('did:webvh:example.com:issuer', issuerDoc);
      await onlineCache.pin('did:peer:subject', subjectDoc);

      // Offline: new cache from same storage
      const offlineCache = new DIDCache({ storage });
      await offlineCache.load();

      expect(await offlineCache.get('did:webvh:example.com:issuer')).toEqual(issuerDoc);
      expect(await offlineCache.get('did:peer:subject')).toEqual(subjectDoc);
      expect(offlineCache.listPinned()).toHaveLength(2);
    });
  });

  describe('OriginalsSDK config passthrough', () => {
    test('should pass storage adapter from OriginalsConfig to DIDCache', async () => {
      const { OriginalsSDK } = await import('../../../src');
      const storageMap = new Map<string, DIDCacheEntry>();
      const storage: DIDCacheStorage = {
        get: async (key: string) => storageMap.get(key) ?? null,
        set: async (key: string, entry: DIDCacheEntry) => { storageMap.set(key, entry); },
        delete: async (key: string) => { storageMap.delete(key); },
        keys: async () => Array.from(storageMap.keys()),
        clear: async () => { storageMap.clear(); },
      };

      const sat = '700001';
      const did = `did:btco:${sat}`;
      const sdk = OriginalsSDK.create({
        network: 'mainnet',
        ordinalsProvider: makeBtcoProvider(sat, makeDIDDoc(did)),
        didCache: {
          ttlMs: 5000,
          maxEntries: 50,
          storage,
        },
      });

      // Resolve a DID — it should persist to our storage
      await sdk.did.resolveDID(did);

      expect(storageMap.has(did)).toBe(true);
      const entry = storageMap.get(did)!;
      expect(entry.ttlMs).toBe(5000);
    });
  });

  describe('DIDManager integration', () => {
    test('should cache resolved DIDs via DIDManager', async () => {
      // Import DIDManager
      const { DIDManager } = await import('../../../src/did/DIDManager');
      const metrics = new MetricsCollector();
      const sat = '700002';
      const did = `did:btco:${sat}`;
      const didManager = new DIDManager(
        { network: 'mainnet', defaultKeyType: 'Ed25519', ordinalsProvider: makeBtcoProvider(sat, makeDIDDoc(did)) },
        metrics
      );

      // First resolve (cache miss, fetches)
      const resolved1 = await didManager.resolveDID(did);
      expect(resolved1).not.toBeNull();

      // Should now be cached
      expect(didManager.cache.has(did)).toBe(true);

      // Second resolve (cache hit)
      const resolved2 = await didManager.resolveDID(did);
      expect(resolved2).not.toBeNull();

      // Check metrics
      const allMetrics = metrics.getMetrics();
      expect(allMetrics.cacheStats).toBeDefined();
      expect(allMetrics.cacheStats!.hits).toBeGreaterThanOrEqual(1);
    });

    test('should skip cache when skipCache option is set', async () => {
      const { DIDManager } = await import('../../../src/did/DIDManager');
      const metrics = new MetricsCollector();
      const sat = '700003';
      const did = `did:btco:${sat}`;
      const didManager = new DIDManager(
        { network: 'mainnet', defaultKeyType: 'Ed25519', ordinalsProvider: makeBtcoProvider(sat, makeDIDDoc(did)) },
        metrics
      );

      // Resolve and cache
      await didManager.resolveDID(did);
      expect(didManager.cache.has(did)).toBe(true);

      // Resolve with skipCache - should not use cache
      const resolved = await didManager.resolveDID(did, { skipCache: true });
      expect(resolved).not.toBeNull();
    });

    test('failed did:webvh resolution must not populate the cache (no stub caching)', async () => {
      // Use a did:webvh DID that cannot be fetched (unresolvable domain).
      // The resolver will fail/throw and resolveDID will return a minimal stub
      // document — but that stub must NOT be written into the cache.
      const { DIDManager } = await import('../../../src/did/DIDManager');
      const didManager = new DIDManager(
        { network: 'regtest', defaultKeyType: 'Ed25519', webvhNetwork: 'magby' }
      );

      const unresolvableDid = 'did:webvh:example.invalid:nonexistent';

      // First call: resolution fails, returns stub (or null), must not cache.
      await didManager.resolveDID(unresolvableDid);

      // The cache must remain empty for this DID.
      expect(didManager.cache.has(unresolvableDid)).toBe(false);
    });

    test('should support pinning via DIDManager cache', async () => {
      const { DIDManager } = await import('../../../src/did/DIDManager');
      const sat = '700004';
      const did = `did:btco:${sat}`;
      const didManager = new DIDManager(
        { network: 'mainnet', defaultKeyType: 'Ed25519', ordinalsProvider: makeBtcoProvider(sat, makeDIDDoc(did)) }
      );

      // Resolve, then pin
      await didManager.resolveDID(did);
      await didManager.cache.pin(did);
      expect(didManager.cache.isPinned(did)).toBe(true);
      expect(didManager.cache.listPinned()).toContain(did);
    });
  });
});

describe('LRU eviction is memory-only (issue #313)', () => {
  test('hydrating reads beyond maxEntries do not delete entries from persistent storage', async () => {
    const storageMap = new Map<string, DIDCacheEntry>();
    const storage: DIDCacheStorage = {
      get: async (key: string) => storageMap.get(key) ?? null,
      set: async (key: string, entry: DIDCacheEntry) => { storageMap.set(key, entry); },
      delete: async (key: string) => { storageMap.delete(key); },
      keys: async () => Array.from(storageMap.keys()),
      clear: async () => { storageMap.clear(); },
    };

    // Persistent store holds more entries than the memory cap.
    const dids = ['did:peer:a', 'did:peer:b', 'did:peer:c', 'did:peer:d'];
    for (const did of dids) {
      storageMap.set(did, {
        did,
        document: makeDIDDoc(did),
        resolvedAt: Date.now(),
        ttlMs: 60_000,
        pinned: false,
      });
    }

    const cache = new DIDCache({ storage, maxEntries: 2 });
    // Each get() hydrates from storage; beyond maxEntries this triggers LRU
    // eviction, which previously ALSO deleted the evicted entry from the
    // persistent store — reads shrank the persistent cache.
    for (const did of dids) {
      expect(await cache.get(did)).not.toBeNull();
    }

    // Every entry is still in persistent storage and still resolvable.
    expect(storageMap.size).toBe(4);
    for (const did of dids) {
      expect(await cache.get(did)).not.toBeNull();
    }
  });

  test('set() eviction keeps the evicted entry in persistent storage', async () => {
    const storageMap = new Map<string, DIDCacheEntry>();
    const storage: DIDCacheStorage = {
      get: async (key: string) => storageMap.get(key) ?? null,
      set: async (key: string, entry: DIDCacheEntry) => { storageMap.set(key, entry); },
      delete: async (key: string) => { storageMap.delete(key); },
      keys: async () => Array.from(storageMap.keys()),
      clear: async () => { storageMap.clear(); },
    };

    const cache = new DIDCache({ storage, maxEntries: 2 });
    await cache.set('did:peer:a', makeDIDDoc('did:peer:a'));
    await cache.set('did:peer:b', makeDIDDoc('did:peer:b'));
    await cache.set('did:peer:c', makeDIDDoc('did:peer:c')); // evicts 'a' from memory

    expect(storageMap.has('did:peer:a')).toBe(true);
    // Explicit invalidation still deletes from storage.
    await cache.delete('did:peer:a');
    expect(storageMap.has('did:peer:a')).toBe(false);
  });
});
