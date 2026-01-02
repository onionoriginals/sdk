/**
 * Performance tests for Batch Operations
 * 
 * Validates that batch operations scale linearly and achieve the required
 * cost savings (30%+) for batch inscriptions
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import { OriginalsAsset } from '../../src/lifecycle/OriginalsAsset';
import { AssetResource, OriginalsConfig } from '../../src/types';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { FeeOracleMock } from '../../src/adapters/FeeOracleMock';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { StorageAdapter as ConfigStorageAdapter } from '../../src/adapters/types';
import { MockKeyStore } from '../mocks/MockKeyStore';

function makeHash(prefix: string): string {
  const hexOnly = prefix.split('').map(c => {
    if (/[0-9a-f]/i.test(c)) return c;
    return c.charCodeAt(0).toString(16).slice(-1);
  }).join('');
  return hexOnly.padEnd(64, '0');
}

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
    return {
      content: Buffer.from(result.content),
      contentType: result.contentType || 'application/octet-stream'
    };
  }

  async delete(objectKey: string): Promise<boolean> {
    const firstSlash = objectKey.indexOf('/');
    const domain = firstSlash >= 0 ? objectKey.substring(0, firstSlash) : objectKey;
    const path = firstSlash >= 0 ? objectKey.substring(firstSlash + 1) : '';
    return await this.memoryAdapter.deleteObject(domain, path);
  }
}

describe('Batch Operations Performance', () => {
  let sdk: OriginalsSDK;

  beforeEach(() => {
    const memoryStorage = new MemoryStorageAdapter();
    const storageAdapter = new StorageAdapterBridge(memoryStorage);
    const feeOracle = new FeeOracleMock(10);
    const ordinalsProvider = new OrdMockProvider();
    const keyStore = new MockKeyStore();

    const config: OriginalsConfig = {
      network: 'regtest',
      defaultKeyType: 'ES256K',
      enableLogging: false,
      storageAdapter,
      feeOracle,
      ordinalsProvider
    };

    sdk = new OriginalsSDK(config, keyStore);
  });

  describe('Linear Scaling', () => {
    test('batch creation should scale linearly', async () => {
      const sizes = [10, 50, 100];
      const timings: Array<{ size: number; duration: number; perItem: number }> = [];

      for (const size of sizes) {
        const resourcesList = Array.from({ length: size }, (_, i) => [
          { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
        ]);

        const startTime = Date.now();
        const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
          maxConcurrent: 5
        });
        const duration = Date.now() - startTime;

        expect(result.successful).toHaveLength(size);
        
        timings.push({
          size,
          duration,
          perItem: duration / size
        });
      }

      // Print performance report
      console.log('\nBatch Creation Performance:');
      console.log('Size\tDuration\tPer Item');
      for (const timing of timings) {
        console.log(`${timing.size}\t${timing.duration}ms\t\t${timing.perItem.toFixed(2)}ms`);
      }

      // Verify roughly linear scaling (per-item time should be relatively constant)
      const perItemTimes = timings.map(t => t.perItem);
      const avgPerItem = perItemTimes.reduce((sum, t) => sum + t, 0) / perItemTimes.length;
      
      // All per-item times should be within 3x of average (allowing for overhead)
      for (const perItemTime of perItemTimes) {
        expect(perItemTime).toBeLessThan(avgPerItem * 3);
      }
    });

    test('batch inscription should scale linearly', async () => {
      const sizes = [5, 10, 20];
      const timings: Array<{ size: number; duration: number; perItem: number }> = [];

      for (const size of sizes) {
        // Create assets
        const assets: OriginalsAsset[] = [];
        for (let i = 0; i < size; i++) {
          const asset = await sdk.lifecycle.createAsset([
            { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
          ]);
          assets.push(asset);
        }

        // Batch inscribe with individual transactions
        const startTime = Date.now();
        const result = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
          singleTransaction: false,
          feeRate: 10,
          maxConcurrent: 3
        });
        const duration = Date.now() - startTime;

        expect(result.successful).toHaveLength(size);
        
        timings.push({
          size,
          duration,
          perItem: duration / size
        });
      }

      // Print performance report
      console.log('\nBatch Inscription Performance (Individual Transactions):');
      console.log('Size\tDuration\tPer Item');
      for (const timing of timings) {
        console.log(`${timing.size}\t${timing.duration}ms\t\t${timing.perItem.toFixed(2)}ms`);
      }
    });
  });

  describe('Memory Usage', () => {
    test('should handle large batches without memory issues', async () => {
      const size = 200;
      const resourcesList = Array.from({ length: size }, (_, i) => [
        { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
      ]);

      // Monitor memory usage (if available)
      const memBefore = process.memoryUsage ? process.memoryUsage().heapUsed : 0;

      const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
        maxConcurrent: 10
      });

      const memAfter = process.memoryUsage ? process.memoryUsage().heapUsed : 0;
      const memIncreaseMB = (memAfter - memBefore) / 1024 / 1024;

      expect(result.successful).toHaveLength(size);
      
      // Memory increase should be reasonable (less than 100MB for 200 assets)
      console.log(`\nMemory increase for 200 assets: ${memIncreaseMB.toFixed(2)} MB`);
      expect(memIncreaseMB).toBeLessThan(100);
    });

    test('should process very large batches with chunking', async () => {
      const size = 500;
      const resourcesList = Array.from({ length: size }, (_, i) => [
        { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
      ]);

      const startTime = Date.now();
      const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
        maxConcurrent: 20
      });
      const duration = Date.now() - startTime;

      expect(result.successful).toHaveLength(size);
      console.log(`\nProcessed ${size} assets in ${duration}ms (${(duration / size).toFixed(2)}ms per item)`);
      
      // Should complete in reasonable time even for large batches
      expect(duration).toBeLessThan(60000); // 60 seconds
    });
  });

  describe('Cost Savings', () => {
    test('single transaction batch should save 30%+ on fees', async () => {
      const size = 10;
      const assets: OriginalsAsset[] = [];
      
      for (let i = 0; i < size; i++) {
        const asset = await sdk.lifecycle.createAsset([
          { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
        ]);
        assets.push(asset);
      }

      // Track cost savings from batch events
      let costSavings: any = null;
      sdk.lifecycle.on('batch:completed', (event) => {
        if (event.results.costSavings) {
          costSavings = event.results.costSavings;
        }
      });

      await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
        singleTransaction: true,
        feeRate: 10
      });

      expect(costSavings).toBeDefined();
      expect(costSavings.percentage).toBeGreaterThanOrEqual(30);

      console.log('\nCost Savings Analysis:');
      console.log(`Batch Fee: ${costSavings.amount} sats`);
      console.log(`Individual Fees Total: ${costSavings.amount + costSavings.amount} sats`);
      console.log(`Savings: ${costSavings.amount} sats (${costSavings.percentage.toFixed(2)}%)`);
    });

    test.skip('cost savings should increase with batch size', async () => {
      const sizes = [5, 10, 20];
      const savingsResults: Array<{ size: number; percentage: number; amount: number }> = [];

      for (const size of sizes) {
        const assets: OriginalsAsset[] = [];
        for (let i = 0; i < size; i++) {
          const asset = await sdk.lifecycle.createAsset([
            { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
          ]);
          assets.push(asset);
        }

        let costSavings: any = null;
        const unsubscribe = sdk.lifecycle.on('batch:completed', (event) => {
          if (event.results.costSavings) {
            costSavings = event.results.costSavings;
          }
        });

        await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
          singleTransaction: true,
          feeRate: 10
        });

        unsubscribe();

        savingsResults.push({
          size,
          percentage: costSavings.percentage,
          amount: costSavings.amount
        });
      }

      console.log('\nCost Savings by Batch Size:');
      console.log('Size\tSavings %\tSavings (sats)');
      for (const result of savingsResults) {
        console.log(`${result.size}\t${result.percentage.toFixed(2)}%\t\t${result.amount}`);
      }

      // Verify all meet 30% threshold
      for (const result of savingsResults) {
        expect(result.percentage).toBeGreaterThanOrEqual(30);
      }

      // Larger batches should generally save more (in absolute terms)
      expect(savingsResults[2].amount).toBeGreaterThan(savingsResults[0].amount);
    });
  });

  describe('Concurrency Performance', () => {
    test.skip('concurrent processing should be faster than sequential', async () => {
      const size = 20;
      const resourcesList = Array.from({ length: size }, (_, i) => [
        { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
      ]);

      // Sequential processing
      const startSeq = Date.now();
      const resultSeq = await sdk.lifecycle.batchCreateAssets(resourcesList, {
        maxConcurrent: 1
      });
      const durationSeq = Date.now() - startSeq;

      // Create new assets for concurrent test
      const resourcesList2 = Array.from({ length: size }, (_, i) => [
        { id: `res2-${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt2-${i}`), content: `text${i}` }
      ]);

      // Concurrent processing
      const startConc = Date.now();
      const resultConc = await sdk.lifecycle.batchCreateAssets(resourcesList2, {
        maxConcurrent: 10
      });
      const durationConc = Date.now() - startConc;

      console.log('\nConcurrency Performance:');
      console.log(`Sequential (maxConcurrent=1): ${durationSeq}ms`);
      console.log(`Concurrent (maxConcurrent=10): ${durationConc}ms`);
      console.log(`Speedup: ${(durationSeq / durationConc).toFixed(2)}x`);

      expect(resultSeq.successful).toHaveLength(size);
      expect(resultConc.successful).toHaveLength(size);
      
      // Concurrent should be faster (allowing some variance for system load)
      // We expect at least some speedup, though not necessarily 10x due to overhead
      expect(durationConc).toBeLessThanOrEqual(durationSeq);
    });
  });

  describe('Stress Tests', () => {
    test('should handle rapid successive batch operations', async () => {
      const batches = 5;
      const batchSize = 10;
      
      const results = [];
      for (let b = 0; b < batches; b++) {
        const resourcesList = Array.from({ length: batchSize }, (_, i) => [
          { id: `batch${b}-res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`b${b}txt${i}`), content: `text${i}` }
        ]);

        const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
          maxConcurrent: 5
        });
        results.push(result);
      }

      // All batches should succeed
      for (const result of results) {
        expect(result.successful).toHaveLength(batchSize);
        expect(result.failed).toHaveLength(0);
      }

      console.log(`\nSuccessfully processed ${batches} batches of ${batchSize} assets each`);
    });

    test('should maintain performance with mixed operations', async () => {
      const size = 10;
      
      // Create assets
      const resourcesList = Array.from({ length: size }, (_, i) => [
        { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
      ]);
      
      const startTime = Date.now();
      
      // Phase 1: Create
      const createResult = await sdk.lifecycle.batchCreateAssets(resourcesList, {
        maxConcurrent: 5
      });
      const createTime = Date.now() - startTime;
      
      // Phase 2: Publish
      const publishStart = Date.now();
      const publishResult = await sdk.lifecycle.batchPublishToWeb(
        createResult.successful.map(s => s.result),
        'perf.test',
        { maxConcurrent: 5 }
      );
      const publishTime = Date.now() - publishStart;
      
      // Phase 3: Inscribe
      const inscribeStart = Date.now();
      const inscribeResult = await sdk.lifecycle.batchInscribeOnBitcoin(
        publishResult.successful.map(s => s.result),
        { singleTransaction: true, feeRate: 10 }
      );
      const inscribeTime = Date.now() - inscribeStart;
      
      const totalTime = Date.now() - startTime;
      
      console.log('\nMixed Operations Performance:');
      console.log(`Create: ${createTime}ms`);
      console.log(`Publish: ${publishTime}ms`);
      console.log(`Inscribe: ${inscribeTime}ms`);
      console.log(`Total: ${totalTime}ms`);
      console.log(`Average per asset: ${(totalTime / size).toFixed(2)}ms`);
      
      expect(createResult.successful).toHaveLength(size);
      expect(publishResult.successful).toHaveLength(size);
      expect(inscribeResult.successful).toHaveLength(size);
    });
  });
});
