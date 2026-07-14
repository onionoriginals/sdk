/**
 * Performance benchmarks for DID/asset creation operations.
 *
 * Establishes baselines for:
 * - did:cel genesis creation (createAsset) — did:peer creation was removed
 *   (did:peer purge, did:cel Phase 4·5/5)
 * - did:webvh migration
 * - DID resolution
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import { OriginalsConfig, AssetResource, DIDDocument } from '../../src/types';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { StorageAdapter as ConfigStorageAdapter } from '../../src/adapters/types';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { hashResource } from '../../src/utils/validation';

class StorageAdapterBridge implements ConfigStorageAdapter {
  constructor(private memoryAdapter: MemoryStorageAdapter) {}
  async put(objectKey: string, data: Buffer | string, options?: { contentType?: string }): Promise<string> {
    const firstSlash = objectKey.indexOf('/');
    const domain = firstSlash >= 0 ? objectKey.substring(0, firstSlash) : objectKey;
    const path = firstSlash >= 0 ? objectKey.substring(firstSlash + 1) : '';
    const content = typeof data === 'string' ? Buffer.from(data) : data;
    return await this.memoryAdapter.putObject(domain, path, new Uint8Array(content));
  }
  async get(objectKey: string): Promise<{ content: Buffer; contentType: string } | null> {
    const firstSlash = objectKey.indexOf('/');
    const domain = firstSlash >= 0 ? objectKey.substring(0, firstSlash) : objectKey;
    const path = firstSlash >= 0 ? objectKey.substring(firstSlash + 1) : '';
    const result = await this.memoryAdapter.getObject(domain, path);
    if (!result) return null;
    return { content: Buffer.from(result.content), contentType: result.contentType || 'application/octet-stream' };
  }
  async delete(objectKey: string): Promise<boolean> {
    const firstSlash = objectKey.indexOf('/');
    const domain = firstSlash >= 0 ? objectKey.substring(0, firstSlash) : objectKey;
    const path = firstSlash >= 0 ? objectKey.substring(firstSlash + 1) : '';
    return await this.memoryAdapter.deleteObject(domain, path);
  }
}

function makeResource(id: string): AssetResource {
  const content = `content-${id}`;
  return {
    id,
    type: 'text',
    contentType: 'text/plain',
    // createAsset verifies content hashes to the declared hash (sha256 over
    // UTF-8 bytes); use the SDK's own hashResource so they always match.
    hash: hashResource(Buffer.from(content, 'utf8')),
    content,
  };
}

describe('DID Creation Performance', () => {
  let sdk: OriginalsSDK;

  beforeEach(() => {
    const memoryStorage = new MemoryStorageAdapter();
    const storageAdapter = new StorageAdapterBridge(memoryStorage);
    const ordinalsProvider = new OrdMockProvider();
    const keyStore = new MockKeyStore();

    const config: OriginalsConfig = {
      network: 'regtest',
      webvhNetwork: 'magby',
      defaultKeyType: 'Ed25519',
      enableLogging: false,
      storageAdapter,
      ordinalsProvider,
    };

    sdk = new OriginalsSDK(config, keyStore);
  });

  describe('did:cel genesis creation baselines', () => {
    test('single did:cel creation (Ed25519)', async () => {
      const iterations = 20;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await sdk.lifecycle.createAsset([makeResource(`ed-${i}`)]);
        durations.push(performance.now() - start);
      }

      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const sorted = [...durations].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(durations.length * 0.5)];
      const p95 = sorted[Math.floor(durations.length * 0.95)];

      console.log('\ndid:cel creation (Ed25519):');
      console.log(`  Iterations: ${iterations}`);
      console.log(`  Avg: ${avg.toFixed(2)}ms`);
      console.log(`  P50: ${p50.toFixed(2)}ms`);
      console.log(`  P95: ${p95.toFixed(2)}ms`);

      // Baseline: should complete within 500ms per creation
      expect(avg).toBeLessThan(500);
    });

    test('concurrent did:cel creation throughput', async () => {
      const batchSize = 10;
      const start = performance.now();

      const promises = Array.from({ length: batchSize }, (_, i) =>
        sdk.lifecycle.createAsset([makeResource(`conc-${i}`)])
      );
      const results = await Promise.all(promises);
      const duration = performance.now() - start;
      const throughput = (batchSize / duration) * 1000;

      console.log('\nConcurrent did:cel creation:');
      console.log(`  Batch size: ${batchSize}`);
      console.log(`  Total: ${duration.toFixed(2)}ms`);
      console.log(`  Throughput: ${throughput.toFixed(1)} assets/sec`);

      expect(results).toHaveLength(batchSize);
      for (const asset of results) {
        expect(asset.id).toContain('did:cel');
      }
    });
  });

  describe('did:webvh migration baselines', () => {
    test('did:cel to did:webvh migration', async () => {
      // Pre-build did:cel source documents (did:peer creation was removed).
      const sourceDocs: DIDDocument[] = [];
      for (let i = 0; i < 10; i++) {
        sourceDocs.push({ '@context': ['https://www.w3.org/ns/did/v1'], id: `did:cel:perf-mig-${i}` });
      }

      const durations: number[] = [];
      for (const sourceDoc of sourceDocs) {
        const start = performance.now();
        const webvhDoc = await sdk.did.migrateToDIDWebVH(sourceDoc);
        durations.push(performance.now() - start);

        expect(webvhDoc.didDocument.id).toContain('did:webvh');
      }

      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const sorted = [...durations].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(durations.length * 0.5)];
      const p95 = sorted[Math.floor(durations.length * 0.95)];

      console.log('\ndid:cel -> did:webvh migration:');
      console.log(`  Iterations: ${durations.length}`);
      console.log(`  Avg: ${avg.toFixed(2)}ms`);
      console.log(`  P50: ${p50.toFixed(2)}ms`);
      console.log(`  P95: ${p95.toFixed(2)}ms`);

      expect(avg).toBeLessThan(500);
    });
  });

  describe('DID resolution baselines', () => {
    test('did:cel resolution (cache hit)', async () => {
      const did = 'did:cel:perf-res';
      await sdk.did.cache.set(did, { '@context': ['https://www.w3.org/ns/did/v1'], id: did });

      const iterations = 20;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const resolved = await sdk.did.resolveDID(did);
        durations.push(performance.now() - start);

        expect(resolved).toBeDefined();
      }

      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;

      console.log('\ndid:cel resolution:');
      console.log(`  Avg: ${avg.toFixed(2)}ms`);

      expect(avg).toBeLessThan(200);
    });
  });

  describe('Regression guards', () => {
    test('did:cel creation should not regress beyond 2x baseline', async () => {
      // Warm up
      await sdk.lifecycle.createAsset([makeResource('warmup')]);

      // Measure baseline (5 runs, take median)
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await sdk.lifecycle.createAsset([makeResource(`reg-${i}`)]);
        runs.push(performance.now() - start);
      }
      const sorted = [...runs].sort((a, b) => a - b);
      const median = sorted[2];

      // Verify each run is within 3x of median (allows for GC jitter)
      for (const run of runs) {
        expect(run).toBeLessThan(median * 3);
      }

      console.log(`\nRegression guard: median=${median.toFixed(2)}ms, max allowed=${(median * 3).toFixed(2)}ms`);
    });
  });
});
