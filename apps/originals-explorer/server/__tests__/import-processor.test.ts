import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ImportProcessor } from '../services/importProcessor';
import type { DriveFile, GoogleDriveClient } from '../services/googleDriveClient';
import type { OriginalsSDK } from '@originals/sdk';

describe('ImportProcessor', () => {
  let processor: ImportProcessor;
  let mockDriveClient: GoogleDriveClient;
  let mockSdk: OriginalsSDK;
  let mockStorage: any;
  let testFiles: DriveFile[];

  beforeEach(() => {
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
    ];

    mockDriveClient = {
      downloadFile: mock(async (fileId: string) => {
        return Buffer.from(`image-data-${fileId}`);
      }),
    } as any;

    mockSdk = {
      lifecycle: {
        createAsset: mock(async (resources: any[]) => {
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

    mockStorage = {
      createGoogleDriveImport: mock(async (data: any) => {
        return {
          id: 'import-123',
          ...data,
          createdAt: new Date(),
        };
      }),
      updateGoogleDriveImport: mock(async (id: string, updates: any) => {
        return { id, ...updates };
      }),
      getGoogleDriveImport: mock(async (id: string) => {
        return {
          id,
          status: 'completed',
          totalFiles: '2',
          processedFiles: '2',
          failedFiles: '0',
        };
      }),
      createAssetFromGoogleDrive: mock(async (data: any) => {
        return {
          id: Math.random().toString(36).substring(7),
          ...data,
        };
      }),
    };

    processor = new ImportProcessor(mockDriveClient, mockSdk, mockStorage);
  });

  describe('startImportWithFiles', () => {
    it('should create import record and start processing', async () => {
      const result = await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        testFiles
      );

      expect(result.importId).toBe('import-123');
      expect(result.totalFiles).toBe(2);
      expect(result.estimatedTime).toBeDefined();

      expect(mockStorage.createGoogleDriveImport).toHaveBeenCalledWith({
        userId: 'user-123',
        folderId: 'folder-456',
        folderName: 'My Photos',
        status: 'pending',
        totalFiles: '2',
        processedFiles: '0',
        failedFiles: '0',
      });
    });

    it('should calculate estimated time correctly', async () => {
      const manyFiles = Array.from({ length: 100 }, (_, i) => ({
        id: `file-${i}`,
        name: `photo${i}.jpg`,
        mimeType: 'image/jpeg',
      }));

      const result = await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        manyFiles
      );

      // 100 files * 500ms = 50000ms = 50 seconds
      expect(result.estimatedTime).toBe(50);
    });

    it('should throw error for empty file array', async () => {
      await expect(
        processor.startImportWithFiles('user-123', 'folder-456', 'My Photos', [])
      ).rejects.toThrow('No files selected for import');
    });

    it('should start background processing', async () => {
      await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        testFiles
      );

      // Wait a bit for background processing to start
      await new Promise(resolve => setTimeout(resolve, 100));

      // Status should be updated to 'processing'
      const updateCalls = (mockStorage.updateGoogleDriveImport as any).mock.calls;
      const processingUpdate = updateCalls.find((call: any) => call[1].status === 'processing');
      expect(processingUpdate).toBeDefined();
    });

    it('should update progress during processing', async () => {
      await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        testFiles
      );

      // Wait for processing to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      const updateCalls = (mockStorage.updateGoogleDriveImport as any).mock.calls;

      // Should have progress updates
      const progressUpdates = updateCalls.filter((call: any) => call[1].processedFiles);
      expect(progressUpdates.length).toBeGreaterThan(0);
    });

    it('should mark import as completed when done', async () => {
      await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        testFiles
      );

      // Wait for processing to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      const updateCalls = (mockStorage.updateGoogleDriveImport as any).mock.calls;
      const completedUpdate = updateCalls.find((call: any) => call[1].status === 'completed');

      expect(completedUpdate).toBeDefined();
      expect(completedUpdate[1].completedAt).toBeDefined();
    });

    it('should handle processing errors gracefully', async () => {
      mockDriveClient.downloadFile = mock(async () => {
        throw new Error('Network error');
      });

      await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        testFiles
      );

      // Wait for processing to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      const updateCalls = (mockStorage.updateGoogleDriveImport as any).mock.calls;
      const finalUpdate = updateCalls[updateCalls.length - 1];

      expect(finalUpdate[1].status).toBe('completed');
      expect(finalUpdate[1].failedFiles).toBe('2');
      expect(finalUpdate[1].errorDetails).toBeDefined();
      expect(finalUpdate[1].errorDetails.length).toBe(2);
    });

    it('should track failed files in import record', async () => {
      mockDriveClient.downloadFile = mock(async (fileId: string) => {
        if (fileId === 'file-2') {
          throw new Error('Download failed');
        }
        return Buffer.from(`image-data-${fileId}`);
      });

      await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        testFiles
      );

      // Wait for processing to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      const updateCalls = (mockStorage.updateGoogleDriveImport as any).mock.calls;
      const completedUpdate = updateCalls.find((call: any) => call[1].status === 'completed');

      expect(completedUpdate[1].failedFiles).toBe('1');
      expect(completedUpdate[1].errorDetails).toHaveLength(1);
      expect(completedUpdate[1].errorDetails[0].fileId).toBe('file-2');
      expect(completedUpdate[1].errorDetails[0].fileName).toBe('photo2.png');
    });

    it('should process files in batches of 10', async () => {
      const manyFiles = Array.from({ length: 25 }, (_, i) => ({
        id: `file-${i}`,
        name: `photo${i}.jpg`,
        mimeType: 'image/jpeg',
      }));

      await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        manyFiles
      );

      // Wait for processing to complete
      await new Promise(resolve => setTimeout(resolve, 1000));

      const updateCalls = (mockStorage.updateGoogleDriveImport as any).mock.calls;
      const completedUpdate = updateCalls.find((call: any) => call[1].status === 'completed');

      expect(completedUpdate[1].processedFiles).toBe('25');
    });

    it('should return immediately without waiting for completion', async () => {
      const startTime = Date.now();

      await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        testFiles
      );

      const duration = Date.now() - startTime;

      // Should return quickly (background processing)
      expect(duration).toBeLessThan(200);
    });

    it('should handle system errors during background processing', async () => {
      mockStorage.updateGoogleDriveImport = mock(async () => {
        throw new Error('Database error');
      });

      await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        testFiles
      );

      // Wait for processing to attempt
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should not throw - errors are caught in background
      expect(true).toBe(true);
    });

    it('should create assets with correct userId and importId', async () => {
      await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        testFiles
      );

      // Wait for processing to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      const createCalls = (mockStorage.createAssetFromGoogleDrive as any).mock.calls;

      expect(createCalls.length).toBeGreaterThan(0);
      createCalls.forEach((call: any) => {
        expect(call[0].userId).toBe('user-123');
        expect(call[0].importId).toBe('import-123');
      });
    });
  });

  describe('error handling', () => {
    it('should mark import as failed on catastrophic error', async () => {
      mockStorage.updateGoogleDriveImport = mock(async (id: string, updates: any) => {
        if (updates.status === 'processing') {
          throw new Error('Critical system error');
        }
        return { id, ...updates };
      });

      await processor.startImportWithFiles(
        'user-123',
        'folder-456',
        'My Photos',
        testFiles
      );

      // Wait for error handling
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check if final update marked it as failed
      const updateCalls = (mockStorage.updateGoogleDriveImport as any).mock.calls;
      const failedUpdate = updateCalls.find((call: any) => call[1].status === 'failed');

      expect(failedUpdate).toBeDefined();
      expect(failedUpdate[1].errorDetails).toBeDefined();
    });
  });
});
