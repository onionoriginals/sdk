/**
 * Performance tests for Google Drive import
 *
 * These tests verify that the import system can handle:
 * - 250 images in under 5 minutes (real-world benchmark)
 * - Concurrent processing without memory leaks
 * - Large batches efficiently
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { processDriveFilesBatch } from '../../services/batchDidCreator';
import type { DriveFile, GoogleDriveClient } from '../../services/googleDriveClient';
import type { OriginalsSDK } from '@originals/sdk';

describe('Google Drive Import Performance', () => {
  let mockDriveClient: GoogleDriveClient;
  let mockSdk: OriginalsSDK;
  let mockStorage: any;

  beforeEach(() => {
    // Mock Drive client with realistic delays
    mockDriveClient = {
      downloadFile: mock(async (fileId: string) => {
        // Simulate network delay (50ms)
        await new Promise(resolve => setTimeout(resolve, 50));
        return Buffer.from(`image-data-${fileId}`);
      }),
    } as any;

    // Mock SDK with realistic processing time
    mockSdk = {
      lifecycle: {
        createAsset: mock(async (resources: any[]) => {
          // Simulate DID creation time (100ms)
          await new Promise(resolve => setTimeout(resolve, 100));
          const did = `did:peer:${Math.random().toString(36).substring(7)}`;
          return {
            id: did,
            did: { id: did },
            resources: resources.map(r => ({ ...r, hash: 'mock-hash' })),
            currentLayer: 'did:peer',
            getProvenance: () => ({}),
          };
        }),
      },
    } as any;

    // Mock storage
    mockStorage = {
      createAssetFromGoogleDrive: mock(async (data: any) => {
        // Simulate DB write (10ms)
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          id: Math.random().toString(36).substring(7),
          ...data,
        };
      }),
    };
  });

  it('should process 250 files in under 5 minutes (simulated)', async () => {
    const fileCount = 250;
    const maxDurationMs = 5 * 60 * 1000; // 5 minutes

    // Create test files
    const files: DriveFile[] = Array.from({ length: fileCount }, (_, i) => ({
      id: `file-${i}`,
      name: `photo${i}.jpg`,
      mimeType: 'image/jpeg',
      size: '1024',
    }));

    const startTime = Date.now();

    const result = await processDriveFilesBatch(
      files,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage,
      { batchSize: 20 } // Optimized batch size
    );

    const duration = Date.now() - startTime;

    expect(result.successful).toHaveLength(fileCount);
    expect(result.failed).toHaveLength(0);
    expect(result.totalProcessed).toBe(fileCount);

    // Should complete in under 5 minutes
    // With batch size 20 and ~160ms per file, 250 files should take ~2 minutes
    expect(duration).toBeLessThan(maxDurationMs);

    const durationSeconds = duration / 1000;
    const avgTimePerFile = duration / fileCount;
    const filesPerSecond = fileCount / durationSeconds;

    console.log(`\n  Performance metrics:`);
    console.log(`    Duration: ${durationSeconds.toFixed(2)}s`);
    console.log(`    Avg per file: ${avgTimePerFile.toFixed(0)}ms`);
    console.log(`    Throughput: ${filesPerSecond.toFixed(2)} files/sec`);
  }, 360000); // 6 minute timeout for the test

  it('should process 100 files efficiently', async () => {
    const files: DriveFile[] = Array.from({ length: 100 }, (_, i) => ({
      id: `file-${i}`,
      name: `photo${i}.jpg`,
      mimeType: 'image/jpeg',
    }));

    const startTime = Date.now();

    const result = await processDriveFilesBatch(
      files,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage,
      { batchSize: 20 }
    );

    const duration = Date.now() - startTime;

    expect(result.successful).toHaveLength(100);

    // 100 files should complete in well under 2 minutes
    expect(duration).toBeLessThan(2 * 60 * 1000);
  }, 180000);

  it('should handle different batch sizes efficiently', async () => {
    const files: DriveFile[] = Array.from({ length: 50 }, (_, i) => ({
      id: `file-${i}`,
      name: `photo${i}.jpg`,
      mimeType: 'image/jpeg',
    }));

    const batchSizes = [5, 10, 20, 30];
    const results: Array<{ batchSize: number; duration: number }> = [];

    for (const batchSize of batchSizes) {
      const startTime = Date.now();

      await processDriveFilesBatch(
        files,
        mockSdk,
        mockDriveClient,
        'user-123',
        'import-456',
        mockStorage,
        { batchSize }
      );

      const duration = Date.now() - startTime;
      results.push({ batchSize, duration });
    }

    // Larger batch sizes should generally be faster (up to a point)
    const batch5 = results.find(r => r.batchSize === 5)!;
    const batch20 = results.find(r => r.batchSize === 20)!;

    console.log(`\n  Batch size comparison:`);
    results.forEach(r => {
      console.log(`    Batch ${r.batchSize}: ${(r.duration / 1000).toFixed(2)}s`);
    });

    // Batch 20 should be faster than batch 5
    expect(batch20.duration).toBeLessThan(batch5.duration);
  }, 120000);

  it('should not leak memory with large batches', async () => {
    const files: DriveFile[] = Array.from({ length: 100 }, (_, i) => ({
      id: `file-${i}`,
      name: `photo${i}.jpg`,
      mimeType: 'image/jpeg',
      size: '10240', // 10KB each
    }));

    const initialMemory = process.memoryUsage().heapUsed;

    await processDriveFilesBatch(
      files,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage,
      { batchSize: 20 }
    );

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    const finalMemory = process.memoryUsage().heapUsed;
    const memoryIncreaseMB = (finalMemory - initialMemory) / 1024 / 1024;

    console.log(`\n  Memory usage:`);
    console.log(`    Initial: ${(initialMemory / 1024 / 1024).toFixed(2)} MB`);
    console.log(`    Final: ${(finalMemory / 1024 / 1024).toFixed(2)} MB`);
    console.log(`    Increase: ${memoryIncreaseMB.toFixed(2)} MB`);

    // Memory increase should be reasonable (<100MB for 100 files)
    // This is a loose check since we're storing resources in memory during processing
    expect(memoryIncreaseMB).toBeLessThan(100);
  }, 120000);

  it('should maintain throughput with failures', async () => {
    const files: DriveFile[] = Array.from({ length: 100 }, (_, i) => ({
      id: `file-${i}`,
      name: `photo${i}.jpg`,
      mimeType: 'image/jpeg',
    }));

    // Simulate 20% failure rate
    mockDriveClient.downloadFile = mock(async (fileId: string) => {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (Math.random() < 0.2) {
        throw new Error('Random network error');
      }
      return Buffer.from(`image-data-${fileId}`);
    });

    const startTime = Date.now();

    const result = await processDriveFilesBatch(
      files,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage,
      { batchSize: 20 }
    );

    const duration = Date.now() - startTime;

    expect(result.totalProcessed).toBe(100);
    expect(result.failed.length).toBeGreaterThan(0);

    // Should still complete in reasonable time despite failures
    expect(duration).toBeLessThan(90 * 1000); // 90 seconds
  }, 120000);

  it('should process files in parallel within batches', async () => {
    const files: DriveFile[] = Array.from({ length: 20 }, (_, i) => ({
      id: `file-${i}`,
      name: `photo${i}.jpg`,
      mimeType: 'image/jpeg',
    }));

    const downloadTimes: number[] = [];

    mockDriveClient.downloadFile = mock(async (fileId: string) => {
      downloadTimes.push(Date.now());
      await new Promise(resolve => setTimeout(resolve, 100));
      return Buffer.from(`image-data-${fileId}`);
    });

    await processDriveFilesBatch(
      files,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage,
      { batchSize: 10 }
    );

    // Check that downloads in first batch started within narrow time window
    const firstBatchTimes = downloadTimes.slice(0, 10);
    const timeSpan = Math.max(...firstBatchTimes) - Math.min(...firstBatchTimes);

    // All files in batch should start within 50ms (parallel execution)
    expect(timeSpan).toBeLessThan(50);
  }, 60000);
});
