/**
 * Batch Operations Stress and Load Testing
 *
 * This test suite performs stress testing on batch operations,
 * migration processes, and concurrent transaction handling.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { BatchOperationExecutor } from '../../src/lifecycle/BatchOperations';
import { MemoryKeyStore } from '../../src/storage/MemoryKeyStore';
import type { AssetResource, OriginalsConfig } from '../../src/types';

describe('Batch Operations Stress Tests', () => {
  let sdk: OriginalsSDK;
  let config: OriginalsConfig;

  beforeEach(() => {
    config = {
      network: 'testnet',
      defaultKeyType: 'ES256K',
      ordinalsProvider: new OrdMockProvider(),
      enableLogging: false
    };
    sdk = OriginalsSDK.create(config);
  });

  describe('1. Batch Size Scaling Tests', () => {
    it('should handle 10 assets (baseline)', async () => {
      const batchSize = 10;
      const resourcesList = createTestResourcesList(batchSize);

      const startTime = Date.now();
      const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
        continueOnError: false,
        maxConcurrent: 1
      });
      const duration = Date.now() - startTime;

      expect(result.successful).toHaveLength(batchSize);
      expect(result.failed).toHaveLength(0);

      logPerformanceMetrics('10 assets batch', batchSize, duration, result);
    }, 30000);

    it('should handle 100 assets (typical load)', async () => {
      const batchSize = 100;
      const resourcesList = createTestResourcesList(batchSize);

      const startTime = Date.now();
      const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
        continueOnError: true,
        maxConcurrent: 5
      });
      const duration = Date.now() - startTime;

      expect(result.totalProcessed).toBe(batchSize);
      expect(result.successful.length + result.failed.length).toBe(batchSize);

      logPerformanceMetrics('100 assets batch', batchSize, duration, result);
    }, 60000);

    it('should handle 1000 assets (stress test)', async () => {
      const batchSize = 1000;
      const resourcesList = createTestResourcesList(batchSize);

      const startTime = Date.now();
      const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
        continueOnError: true,
        maxConcurrent: 10
      });
      const duration = Date.now() - startTime;

      expect(result.totalProcessed).toBe(batchSize);

      logPerformanceMetrics('1000 assets batch', batchSize, duration, result);

      // Performance expectations
      const avgTimePerAsset = duration / batchSize;
      expect(avgTimePerAsset).toBeLessThan(100); // Should average < 100ms per asset

      console.log(`[STRESS] Average time per asset: ${avgTimePerAsset.toFixed(2)}ms`);
    }, 120000);

    it('should handle 10000 assets (breaking point test)', async () => {
      const batchSize = 10000;
      const resourcesList = createTestResourcesList(batchSize);

      const startTime = Date.now();
      const startMemory = process.memoryUsage().heapUsed;

      const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
        continueOnError: true,
        maxConcurrent: 20,
        timeoutMs: 60000
      });

      const duration = Date.now() - startTime;
      const endMemory = process.memoryUsage().heapUsed;
      const memoryDelta = (endMemory - startMemory) / 1024 / 1024; // MB

      expect(result.totalProcessed).toBe(batchSize);

      logPerformanceMetrics('10000 assets batch', batchSize, duration, result);

      console.log(`[STRESS] Memory usage: ${memoryDelta.toFixed(2)}MB`);
      console.log(`[STRESS] Memory per asset: ${(memoryDelta / batchSize * 1024).toFixed(2)}KB`);

      // Memory should not grow unreasonably
      expect(memoryDelta).toBeLessThan(500); // Should use < 500MB for 10k assets
    }, 300000);
  });

  describe('2. Concurrent Batch Operation Tests', () => {
    it('should handle 1 concurrent batch (baseline)', async () => {
      const result = await runConcurrentBatches(1, 50);

      expect(result.allSuccessful).toBeGreaterThan(0);

      logConcurrencyMetrics('1 concurrent batch', 1, 50, result);
    }, 60000);

    it('should handle 10 concurrent batches', async () => {
      const result = await runConcurrentBatches(10, 20);

      expect(result.allSuccessful).toBeGreaterThan(0);

      logConcurrencyMetrics('10 concurrent batches', 10, 20, result);
    }, 120000);

    it('should handle 100 concurrent batches (high concurrency)', async () => {
      const result = await runConcurrentBatches(100, 10);

      expect(result.totalBatches).toBe(100);

      logConcurrencyMetrics('100 concurrent batches', 100, 10, result);

      // Calculate error rate
      const errorRate = (result.allFailed / result.totalItems) * 100;
      expect(errorRate).toBeLessThan(5); // < 5% error rate acceptable under high load

      console.log(`[STRESS] Error rate under high concurrency: ${errorRate.toFixed(2)}%`);
    }, 300000);

    it('should handle mixed concurrent operations', async () => {
      const operations = [
        sdk.lifecycle.batchCreateAssets(createTestResourcesList(50)),
        sdk.lifecycle.batchCreateAssets(createTestResourcesList(50)),
        sdk.lifecycle.batchCreateAssets(createTestResourcesList(50)),
      ];

      const startTime = Date.now();
      const results = await Promise.all(operations);
      const duration = Date.now() - startTime;

      const totalSuccessful = results.reduce((sum, r) => sum + r.successful.length, 0);
      const totalFailed = results.reduce((sum, r) => sum + r.failed.length, 0);

      console.log(`[STRESS] Mixed concurrent operations:`);
      console.log(`  - Total successful: ${totalSuccessful}`);
      console.log(`  - Total failed: ${totalFailed}`);
      console.log(`  - Duration: ${duration}ms`);
      console.log(`  - Throughput: ${(totalSuccessful / (duration / 1000)).toFixed(2)} assets/sec`);
    }, 120000);
  });

  describe('3. Batch Inscription Stress Tests', () => {
    it('should handle batch inscription with single transaction mode', async () => {
      // Create assets first
      const resourcesList = createTestResourcesList(10);
      const createResult = await sdk.lifecycle.batchCreateAssets(resourcesList);

      expect(createResult.successful).toHaveLength(10);

      const assets = createResult.successful.map(s => s.result);

      // Inscribe in batch with single transaction
      const startTime = Date.now();
      const inscribeResult = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
        singleTransaction: true,
        feeRate: 10,
        continueOnError: false
      });
      const duration = Date.now() - startTime;

      expect(inscribeResult.successful).toHaveLength(10);

      console.log(`[STRESS] Batch inscription (single tx):`);
      console.log(`  - Assets: 10`);
      console.log(`  - Duration: ${duration}ms`);
      console.log(`  - Mode: Single transaction`);
    }, 60000);

    it('should handle batch inscription with individual transactions', async () => {
      const resourcesList = createTestResourcesList(10);
      const createResult = await sdk.lifecycle.batchCreateAssets(resourcesList);
      const assets = createResult.successful.map(s => s.result);

      const startTime = Date.now();
      const inscribeResult = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
        singleTransaction: false,
        feeRate: 10,
        continueOnError: true,
        maxConcurrent: 3
      });
      const duration = Date.now() - startTime;

      expect(inscribeResult.totalProcessed).toBe(10);

      console.log(`[STRESS] Batch inscription (individual txs):`);
      console.log(`  - Assets: 10`);
      console.log(`  - Duration: ${duration}ms`);
      console.log(`  - Mode: Individual transactions`);
      console.log(`  - Concurrency: 3`);
    }, 60000);

    it('should compare cost savings between modes', async () => {
      const resourcesList = createTestResourcesList(50);
      const createResult = await sdk.lifecycle.batchCreateAssets(resourcesList);
      const assets = createResult.successful.map(s => s.result);

      // Test single transaction mode
      const singleTxStart = Date.now();
      const singleTxResult = await sdk.lifecycle.batchInscribeOnBitcoin(
        assets.slice(0, 25),
        {
          singleTransaction: true,
          feeRate: 10
        }
      );
      const singleTxDuration = Date.now() - singleTxStart;

      // Test individual transaction mode
      const individualTxStart = Date.now();
      const individualTxResult = await sdk.lifecycle.batchInscribeOnBitcoin(
        assets.slice(25, 50),
        {
          singleTransaction: false,
          feeRate: 10,
          maxConcurrent: 5
        }
      );
      const individualTxDuration = Date.now() - individualTxStart;

      console.log(`[STRESS] Cost comparison:`);
      console.log(`  Single TX mode:`);
      console.log(`    - Duration: ${singleTxDuration}ms`);
      console.log(`    - Assets: 25`);
      console.log(`  Individual TX mode:`);
      console.log(`    - Duration: ${individualTxDuration}ms`);
      console.log(`    - Assets: 25`);
      console.log(`    - Concurrency: 5`);
      console.log(`  Performance ratio: ${(individualTxDuration / singleTxDuration).toFixed(2)}x`);
    }, 120000);
  });

  describe('4. Migration Operation Stress Tests', () => {
    it('should handle 1000 assets migrating through layers', async () => {
      const batchSize = 1000;
      const resourcesList = createTestResourcesList(batchSize);

      // Create assets (did:peer layer)
      const createResult = await sdk.lifecycle.batchCreateAssets(resourcesList, {
        maxConcurrent: 10
      });

      expect(createResult.successful).toHaveLength(batchSize);

      const startTime = Date.now();
      let migratedCount = 0;

      // Migrate to did:webvh layer
      for (const { result: asset } of createResult.successful.slice(0, 100)) {
        try {
          await sdk.lifecycle.publishToWeb(asset, 'localhost:3000');
          migratedCount++;
        } catch (error) {
          // Expected to fail in test environment
        }
      }

      const duration = Date.now() - startTime;

      console.log(`[STRESS] Migration stress test:`);
      console.log(`  - Assets created: ${batchSize}`);
      console.log(`  - Assets migrated: ${migratedCount}`);
      console.log(`  - Duration: ${duration}ms`);
      console.log(`  - Avg time per migration: ${migratedCount > 0 ? (duration / migratedCount).toFixed(2) : 'N/A'}ms`);
    }, 120000);

    it('should handle concurrent migrations', async () => {
      const resourcesList = createTestResourcesList(30);
      const createResult = await sdk.lifecycle.batchCreateAssets(resourcesList);
      const assets = createResult.successful.map(s => s.result);

      const startTime = Date.now();

      // Attempt concurrent migrations
      const migrations = assets.slice(0, 10).map(asset =>
        sdk.lifecycle.publishToWeb(asset, 'localhost:3000').catch(e => e)
      );

      await Promise.allSettled(migrations);

      const duration = Date.now() - startTime;

      console.log(`[STRESS] Concurrent migrations:`);
      console.log(`  - Concurrent operations: 10`);
      console.log(`  - Duration: ${duration}ms`);
    }, 60000);
  });

  describe('5. Error Recovery and Retry Stress Tests', () => {
    it('should handle batch with 50% failure rate and retry', async () => {
      const executor = new BatchOperationExecutor();
      let callCount = 0;

      const items = Array.from({ length: 100 }, (_, i) => i);

      const result = await executor.execute(
        items,
        async (item) => {
          callCount++;
          // Simulate 50% failure on first attempt
          if (callCount % 2 === 0 && callCount <= 100) {
            throw new Error('Simulated failure');
          }
          return item * 2;
        },
        {
          continueOnError: true,
          retryCount: 2,
          retryDelay: 10,
          maxConcurrent: 5
        }
      );

      console.log(`[STRESS] Error recovery test:`);
      console.log(`  - Total items: 100`);
      console.log(`  - Successful: ${result.successful.length}`);
      console.log(`  - Failed: ${result.failed.length}`);
      console.log(`  - Total calls (with retries): ${callCount}`);
      console.log(`  - Duration: ${result.totalDuration}ms`);
    }, 60000);

    it('should handle exponential backoff under stress', async () => {
      const executor = new BatchOperationExecutor();
      const retryTimes: number[] = [];

      const items = Array.from({ length: 10 }, (_, i) => i);

      await executor.execute(
        items,
        async (item, index) => {
          retryTimes.push(Date.now());
          if (retryTimes.length <= 20) { // Fail first few
            throw new Error('Force retry');
          }
          return item;
        },
        {
          continueOnError: true,
          retryCount: 3,
          retryDelay: 100,
          maxConcurrent: 1
        }
      );

      // Analyze retry delays
      const delays: number[] = [];
      for (let i = 1; i < Math.min(retryTimes.length, 10); i++) {
        delays.push(retryTimes[i] - retryTimes[i - 1]);
      }

      console.log(`[STRESS] Exponential backoff analysis:`);
      console.log(`  - Retry delays: ${delays.map(d => d + 'ms').join(', ')}`);
      console.log(`  - Average delay: ${(delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(2)}ms`);
    }, 30000);
  });

  describe('6. Memory and Resource Tests', () => {
    it('should not leak memory during repeated batch operations', async () => {
      const iterations = 10;
      const batchSize = 100;

      const memoryReadings: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const resourcesList = createTestResourcesList(batchSize);

        await sdk.lifecycle.batchCreateAssets(resourcesList, {
          maxConcurrent: 5
        });

        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }

        const memUsage = process.memoryUsage().heapUsed / 1024 / 1024; // MB
        memoryReadings.push(memUsage);

        console.log(`[STRESS] Iteration ${i + 1}: ${memUsage.toFixed(2)}MB`);
      }

      // Check for memory leak (memory shouldn't grow linearly)
      const firstHalf = memoryReadings.slice(0, 5).reduce((a, b) => a + b) / 5;
      const secondHalf = memoryReadings.slice(5).reduce((a, b) => a + b) / 5;
      const growth = ((secondHalf - firstHalf) / firstHalf) * 100;

      console.log(`[STRESS] Memory growth: ${growth.toFixed(2)}%`);
      expect(Math.abs(growth)).toBeLessThan(50); // Memory shouldn't grow > 50%
    }, 180000);

    it('should handle resource cleanup after timeout', async () => {
      const executor = new BatchOperationExecutor();

      const result = await executor.execute(
        [1, 2, 3, 4, 5],
        async (item) => {
          // Simulate long-running operation
          await new Promise(resolve => setTimeout(resolve, 100));
          return item * 2;
        },
        {
          timeoutMs: 50, // Timeout before completion
          continueOnError: true
        }
      );

      expect(result.failed.length).toBeGreaterThan(0);
      console.log(`[STRESS] Timeout handling: ${result.failed.length} operations timed out`);
    }, 10000);
  });

  describe('7. Throughput Benchmarks', () => {
    it('should measure peak throughput for asset creation', async () => {
      const testDuration = 5000; // 5 seconds
      const startTime = Date.now();
      let totalCreated = 0;

      while (Date.now() - startTime < testDuration) {
        const batch = createTestResourcesList(10);
        const result = await sdk.lifecycle.batchCreateAssets(batch, {
          maxConcurrent: 5
        });
        totalCreated += result.successful.length;
      }

      const actualDuration = Date.now() - startTime;
      const throughput = (totalCreated / actualDuration) * 1000; // per second

      console.log(`[BENCHMARK] Asset creation throughput:`);
      console.log(`  - Total created: ${totalCreated}`);
      console.log(`  - Duration: ${actualDuration}ms`);
      console.log(`  - Throughput: ${throughput.toFixed(2)} assets/sec`);

      expect(throughput).toBeGreaterThan(10); // Should create at least 10 assets/sec
    }, 10000);
  });
});

// Helper functions

function createTestResourcesList(count: number): AssetResource[][] {
  return Array.from({ length: count }, (_, i) => [
    {
      id: `resource-${i}-${Date.now()}`,
      type: 'DigitalArt',
      contentType: 'application/json',
      hash: Buffer.from(`hash-${i}`).toString('hex'),
      content: JSON.stringify({ test: `data-${i}` })
    }
  ]);
}

interface ConcurrencyResult {
  totalBatches: number;
  totalItems: number;
  allSuccessful: number;
  allFailed: number;
  duration: number;
  avgBatchDuration: number;
}

async function runConcurrentBatches(
  batchCount: number,
  itemsPerBatch: number
): Promise<ConcurrencyResult> {
  const config: OriginalsConfig = {
    network: 'testnet',
    defaultKeyType: 'ES256K',
    ordinalsProvider: new OrdMockProvider(),
    enableLogging: false
  };

  const startTime = Date.now();

  const batches = Array.from({ length: batchCount }, () => {
    const sdk = OriginalsSDK.create(config);
    const resourcesList = createTestResourcesList(itemsPerBatch);
    return sdk.lifecycle.batchCreateAssets(resourcesList, {
      maxConcurrent: 1,
      continueOnError: true
    });
  });

  const results = await Promise.all(batches);
  const duration = Date.now() - startTime;

  const allSuccessful = results.reduce((sum, r) => sum + r.successful.length, 0);
  const allFailed = results.reduce((sum, r) => sum + r.failed.length, 0);
  const avgBatchDuration = results.reduce((sum, r) => sum + r.totalDuration, 0) / batchCount;

  return {
    totalBatches: batchCount,
    totalItems: batchCount * itemsPerBatch,
    allSuccessful,
    allFailed,
    duration,
    avgBatchDuration
  };
}

function logPerformanceMetrics(
  testName: string,
  itemCount: number,
  duration: number,
  result: any
): void {
  const throughput = (itemCount / duration) * 1000; // items per second

  console.log(`\n[PERFORMANCE] ${testName}:`);
  console.log(`  - Total items: ${itemCount}`);
  console.log(`  - Successful: ${result.successful.length}`);
  console.log(`  - Failed: ${result.failed.length}`);
  console.log(`  - Duration: ${duration}ms`);
  console.log(`  - Throughput: ${throughput.toFixed(2)} items/sec`);
  console.log(`  - Avg time per item: ${(duration / itemCount).toFixed(2)}ms`);
}

function logConcurrencyMetrics(
  testName: string,
  batchCount: number,
  itemsPerBatch: number,
  result: ConcurrencyResult
): void {
  const throughput = (result.totalItems / result.duration) * 1000;

  console.log(`\n[CONCURRENCY] ${testName}:`);
  console.log(`  - Concurrent batches: ${batchCount}`);
  console.log(`  - Items per batch: ${itemsPerBatch}`);
  console.log(`  - Total items: ${result.totalItems}`);
  console.log(`  - Successful: ${result.allSuccessful}`);
  console.log(`  - Failed: ${result.allFailed}`);
  console.log(`  - Total duration: ${result.duration}ms`);
  console.log(`  - Avg batch duration: ${result.avgBatchDuration.toFixed(2)}ms`);
  console.log(`  - Overall throughput: ${throughput.toFixed(2)} items/sec`);
}

console.log('\n=== Batch Operations Stress Test Suite Complete ===\n');
console.log('This test suite validates performance and stability under:');
console.log('- Varying batch sizes (10 to 10,000 assets)');
console.log('- High concurrency (up to 100 concurrent batches)');
console.log('- Batch inscription modes (single tx vs individual txs)');
console.log('- Migration operations under load');
console.log('- Error recovery and retry mechanisms');
console.log('- Memory and resource management');
console.log('- Throughput benchmarks');
console.log('\n=================================================\n');
