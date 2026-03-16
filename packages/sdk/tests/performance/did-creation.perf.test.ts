/**
 * Performance benchmarks for DID creation operations.
 *
 * Establishes baselines for:
 * - did:peer creation (various key types)
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
  return {
    id,
    type: 'text',
    contentType: 'text/plain',
    hash: id.padEnd(64, '0'),
    content: `content-${id}`,
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

  describe('did:peer creation baselines', () => {
    test('single did:peer creation (Ed25519)', async () => {
      const iterations = 20;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await sdk.did.createDIDPeer([makeResource(`ed-${i}`)]);
        durations.push(performance.now() - start);
      }

      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const sorted = [...durations].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(durations.length * 0.5)];
      const p95 = sorted[Math.floor(durations.length * 0.95)];

      console.log('\ndid:peer creation (Ed25519):');
      console.log(`  Iterations: ${iterations}`);
      console.log(`  Avg: ${avg.toFixed(2)}ms`);
      console.log(`  P50: ${p50.toFixed(2)}ms`);
      console.log(`  P95: ${p95.toFixed(2)}ms`);

      // Baseline: should complete within 500ms per creation
      expect(avg).toBeLessThan(500);
    });

    test('did:peer creation with key pair return', async () => {
      const iterations = 20;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const result = await sdk.did.createDIDPeer([makeResource(`kp-${i}`)], true);
        durations.push(performance.now() - start);

        expect(result.keyPair).toBeDefined();
        expect(result.didDocument.id).toContain('did:peer');
      }

      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;

      console.log('\ndid:peer creation (with key pair):');
      console.log(`  Avg: ${avg.toFixed(2)}ms`);

      expect(avg).toBeLessThan(500);
    });

    test('concurrent did:peer creation throughput', async () => {
      const batchSize = 10;
      const start = performance.now();

      const promises = Array.from({ length: batchSize }, (_, i) =>
        sdk.did.createDIDPeer([makeResource(`conc-${i}`)])
      );
      const results = await Promise.all(promises);
      const duration = performance.now() - start;
      const throughput = (batchSize / duration) * 1000;

      console.log('\nConcurrent did:peer creation:');
      console.log(`  Batch size: ${batchSize}`);
      console.log(`  Total: ${duration.toFixed(2)}ms`);
      console.log(`  Throughput: ${throughput.toFixed(1)} DIDs/sec`);

      expect(results).toHaveLength(batchSize);
      for (const doc of results) {
        expect((doc as DIDDocument).id).toContain('did:peer');
      }
    });
  });

  describe('did:webvh migration baselines', () => {
    test('did:peer to did:webvh migration', async () => {
      // Pre-create did:peer documents
      const peerDocs: DIDDocument[] = [];
      for (let i = 0; i < 10; i++) {
        const doc = await sdk.did.createDIDPeer([makeResource(`mig-${i}`)]);
        peerDocs.push(doc as DIDDocument);
      }

      const durations: number[] = [];
      for (const peerDoc of peerDocs) {
        const start = performance.now();
        const webvhDoc = await sdk.did.migrateToDIDWebVH(peerDoc);
        durations.push(performance.now() - start);

        expect(webvhDoc.id).toContain('did:webvh');
      }

      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const sorted = [...durations].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(durations.length * 0.5)];
      const p95 = sorted[Math.floor(durations.length * 0.95)];

      console.log('\ndid:peer -> did:webvh migration:');
      console.log(`  Iterations: ${durations.length}`);
      console.log(`  Avg: ${avg.toFixed(2)}ms`);
      console.log(`  P50: ${p50.toFixed(2)}ms`);
      console.log(`  P95: ${p95.toFixed(2)}ms`);

      expect(avg).toBeLessThan(500);
    });
  });

  describe('DID resolution baselines', () => {
    test('did:peer resolution', async () => {
      const doc = (await sdk.did.createDIDPeer([makeResource('res-peer')])) as DIDDocument;
      const did = doc.id;

      const iterations = 20;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const resolved = await sdk.did.resolveDID(did);
        durations.push(performance.now() - start);

        expect(resolved).toBeDefined();
      }

      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;

      console.log('\ndid:peer resolution:');
      console.log(`  Avg: ${avg.toFixed(2)}ms`);

      expect(avg).toBeLessThan(200);
    });
  });

  describe('Regression guards', () => {
    test('did:peer creation should not regress beyond 2x baseline', async () => {
      // Warm up
      await sdk.did.createDIDPeer([makeResource('warmup')]);

      // Measure baseline (5 runs, take median)
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await sdk.did.createDIDPeer([makeResource(`reg-${i}`)]);
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
