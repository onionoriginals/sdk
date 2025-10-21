import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { processDriveFilesBatch } from '../services/batchDidCreator';
import type { DriveFile, GoogleDriveClient } from '../services/googleDriveClient';
import type { OriginalsSDK } from '@originals/sdk';

describe('processDriveFilesBatch', () => {
  let mockDriveClient: GoogleDriveClient;
  let mockSdk: OriginalsSDK;
  let mockStorage: any;
  let testFiles: DriveFile[];
  let successfulDids: string[];

  beforeEach(() => {
    successfulDids = [];

    // Create test files
    testFiles = [
      {
        id: 'file-1',
        name: 'photo1.jpg',
        mimeType: 'image/jpeg',
        size: '1024',
      },
      {
        id: 'file-2',
        name: 'photo2.png',
        mimeType: 'image/png',
        size: '2048',
      },
      {
        id: 'file-3',
        name: 'photo3.gif',
        mimeType: 'image/gif',
        size: '512',
      },
    ];

    // Mock Drive client
    mockDriveClient = {
      downloadFile: mock(async (fileId: string) => {
        return Buffer.from(`image-data-${fileId}`);
      }),
    } as any;

    // Mock SDK
    mockSdk = {
      lifecycle: {
        createAsset: mock(async (resources: any[]) => {
          const did = `did:peer:${Math.random().toString(36).substring(7)}`;
          successfulDids.push(did);
          return {
            id: did,
            did: {
              '@context': ['https://www.w3.org/ns/did/v1'],
              id: did,
            },
            resources: resources.map(r => ({
              ...r,
              hash: r.hash || 'mock-hash',
            })),
            currentLayer: 'did:peer',
            getProvenance: () => ({}),
          };
        }),
      },
    } as any;

    // Mock storage
    mockStorage = {
      createAssetFromGoogleDrive: mock(async (data: any) => {
        return {
          id: Math.random().toString(36).substring(7),
          ...data,
        };
      }),
    };
  });

  it('should process all files successfully', async () => {
    const result = await processDriveFilesBatch(
      testFiles,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage
    );

    expect(result.successful).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.totalProcessed).toBe(3);
  });

  it('should process files in batches', async () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      id: `file-${i}`,
      name: `photo${i}.jpg`,
      mimeType: 'image/jpeg',
    }));

    const result = await processDriveFilesBatch(
      files,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage,
      { batchSize: 10 }
    );

    expect(result.totalProcessed).toBe(25);
    expect(result.successful).toHaveLength(25);
  });

  it('should call progress callback for each file', async () => {
    const progressCalls: Array<{ current: number; total: number; fileName: string }> = [];
    const onProgress = mock((current: number, total: number, file: DriveFile) => {
      progressCalls.push({ current, total, fileName: file.name });
    });

    await processDriveFilesBatch(
      testFiles,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage,
      { onProgress }
    );

    expect(progressCalls).toHaveLength(3);
    expect(progressCalls[0].current).toBe(1);
    expect(progressCalls[0].total).toBe(3);
    expect(progressCalls[2].current).toBe(3);
  });

  it('should handle individual file failures without stopping batch', async () => {
    mockDriveClient.downloadFile = mock(async (fileId: string) => {
      if (fileId === 'file-2') {
        throw new Error('Download failed');
      }
      return Buffer.from(`image-data-${fileId}`);
    });

    const result = await processDriveFilesBatch(
      testFiles,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage
    );

    expect(result.successful).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].file.id).toBe('file-2');
    expect(result.failed[0].error).toContain('Download failed');
    expect(result.totalProcessed).toBe(3);
  });

  it('should call error callback for failed files', async () => {
    mockDriveClient.downloadFile = mock(async (fileId: string) => {
      if (fileId === 'file-2') {
        throw new Error('Network error');
      }
      return Buffer.from(`image-data-${fileId}`);
    });

    const errorCalls: Array<{ fileName: string; error: string }> = [];
    const onError = mock((file: DriveFile, error: Error) => {
      errorCalls.push({ fileName: file.name, error: error.message });
    });

    await processDriveFilesBatch(
      testFiles,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage,
      { onError }
    );

    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].fileName).toBe('photo2.png');
    expect(errorCalls[0].error).toContain('Network error');
  });

  it('should store only resource metadata, not full content', async () => {
    await processDriveFilesBatch(
      testFiles,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage
    );

    const storageCall = (mockStorage.createAssetFromGoogleDrive as any).mock.calls[0][0];
    const resources = storageCall.resources;

    expect(resources).toBeDefined();
    expect(Array.isArray(resources)).toBe(true);

    // Check that resources don't contain 'content' field (which has large base64 data)
    resources.forEach((resource: any) => {
      expect(resource.content).toBeUndefined();
      expect(resource.id).toBeDefined();
      expect(resource.type).toBeDefined();
      expect(resource.hash).toBeDefined();
    });
  });

  it('should include Google Drive metadata when storing assets', async () => {
    await processDriveFilesBatch(
      testFiles,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage
    );

    const storageCall = (mockStorage.createAssetFromGoogleDrive as any).mock.calls[0][0];

    expect(storageCall.userId).toBe('user-123');
    expect(storageCall.importId).toBe('import-456');
    expect(storageCall.sourceMetadata).toBeDefined();
    expect(storageCall.sourceMetadata.googleDriveFileId).toBe('file-1');
    expect(storageCall.sourceMetadata.fileName).toBe('photo1.jpg');
    expect(storageCall.sourceMetadata.mimeType).toBe('image/jpeg');
  });

  it('should respect custom batch size', async () => {
    const files = Array.from({ length: 15 }, (_, i) => ({
      id: `file-${i}`,
      name: `photo${i}.jpg`,
      mimeType: 'image/jpeg',
    }));

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    mockSdk.lifecycle.createAsset = mock(async (resources: any[]) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

      await new Promise(resolve => setTimeout(resolve, 10));

      currentConcurrent--;

      const did = `did:peer:${Math.random().toString(36).substring(7)}`;
      return {
        id: did,
        did: { id: did },
        resources: resources.map(r => ({ ...r, hash: 'mock-hash' })),
        currentLayer: 'did:peer',
        getProvenance: () => ({}),
      };
    });

    await processDriveFilesBatch(
      files,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage,
      { batchSize: 5 }
    );

    // Max concurrent should be <= batch size
    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });

  it('should add delay between batches', async () => {
    const files = Array.from({ length: 15 }, (_, i) => ({
      id: `file-${i}`,
      name: `photo${i}.jpg`,
      mimeType: 'image/jpeg',
    }));

    const startTime = Date.now();

    await processDriveFilesBatch(
      files,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage,
      { batchSize: 5 }
    );

    const duration = Date.now() - startTime;

    // Should have at least 2 delays of 100ms (3 batches = 2 delays)
    expect(duration).toBeGreaterThanOrEqual(150);
  });

  it('should return detailed results for successful files', async () => {
    const result = await processDriveFilesBatch(
      testFiles,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage
    );

    result.successful.forEach((fileResult, index) => {
      expect(fileResult.success).toBe(true);
      expect(fileResult.file).toEqual(testFiles[index]);
      expect(fileResult.did).toBeDefined();
      expect(fileResult.did).toMatch(/^did:peer:/);
      expect(fileResult.didDocument).toBeDefined();
      expect(fileResult.assetId).toBeDefined();
    });
  });

  it('should return detailed error information for failed files', async () => {
    mockSdk.lifecycle.createAsset = mock(async () => {
      throw new Error('SDK validation error: Invalid resource hash');
    });

    const result = await processDriveFilesBatch(
      testFiles,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage
    );

    expect(result.failed).toHaveLength(3);
    result.failed.forEach((fileResult, index) => {
      expect(fileResult.success).toBe(false);
      expect(fileResult.file).toEqual(testFiles[index]);
      expect(fileResult.error).toContain('SDK validation error');
      expect(fileResult.did).toBeUndefined();
    });
  });

  it('should handle empty file array', async () => {
    const result = await processDriveFilesBatch(
      [],
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage
    );

    expect(result.successful).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.totalProcessed).toBe(0);
  });

  it('should handle storage errors', async () => {
    mockStorage.createAssetFromGoogleDrive = mock(async () => {
      throw new Error('Database connection error');
    });

    const result = await processDriveFilesBatch(
      testFiles,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage
    );

    expect(result.failed).toHaveLength(3);
    expect(result.successful).toHaveLength(0);
    expect(result.failed[0].error).toContain('Database connection error');
  });

  it('should process files in parallel within batch', async () => {
    const timestamps: number[] = [];

    mockDriveClient.downloadFile = mock(async (fileId: string) => {
      timestamps.push(Date.now());
      await new Promise(resolve => setTimeout(resolve, 50));
      return Buffer.from(`image-data-${fileId}`);
    });

    await processDriveFilesBatch(
      testFiles,
      mockSdk,
      mockDriveClient,
      'user-123',
      'import-456',
      mockStorage,
      { batchSize: 10 }
    );

    // All 3 files should start within a short time window (parallel execution)
    const timeSpan = Math.max(...timestamps) - Math.min(...timestamps);
    expect(timeSpan).toBeLessThan(100); // Started within 100ms
  });
});
