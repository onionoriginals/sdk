import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import express from 'express';
import { registerRoutes } from '../../server/routes';
import { storage } from '../../server/storage';
import type { Server } from 'http';

describe('Google Drive Import API Integration', () => {
  let app: express.Application;
  let server: Server;
  let serverUrl: string;
  let testUser: any;

  // Mock Google Drive client responses
  const mockTestConnection = mock(async () => true);
  const mockGetFolderMetadata = mock(async (folderId: string) => ({
    id: folderId,
    name: 'Test Folder',
  }));
  const mockListImageFilesRecursive = mock(async (folderId: string) => ({
    files: [
      {
        id: 'img-1',
        name: 'photo1.jpg',
        mimeType: 'image/jpeg',
        size: '1024',
        webViewLink: 'https://drive.google.com/file/d/img-1/view',
      },
      {
        id: 'img-2',
        name: 'photo2.png',
        mimeType: 'image/png',
        size: '2048',
        webViewLink: 'https://drive.google.com/file/d/img-2/view',
      },
    ],
    totalCount: 2,
    errors: [],
  }));
  const mockGetFileMetadata = mock(async (fileId: string) => ({
    id: fileId,
    name: `file-${fileId}.jpg`,
    mimeType: 'image/jpeg',
    size: '1024',
  }));
  const mockDownloadFile = mock(async (fileId: string) => {
    return Buffer.from(`image-data-${fileId}`);
  });

  // Mock the Google Drive client module
  mock.module('../../server/services/googleDriveClient', () => ({
    GoogleDriveClient: class MockGoogleDriveClient {
      testConnection = mockTestConnection;
      getFolderMetadata = mockGetFolderMetadata;
      listImageFilesRecursive = mockListImageFilesRecursive;
      getFileMetadata = mockGetFileMetadata;
      downloadFile = mockDownloadFile;
    },
    createGoogleDriveClient: (accessToken: string) => {
      return new (mock.module('../../server/services/googleDriveClient', () => ({})) as any).GoogleDriveClient();
    },
  }));

  beforeEach(async () => {
    // Setup Express app
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    // Register routes
    server = await registerRoutes(app);

    // Start server on random port
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 5000;
        serverUrl = `http://localhost:${port}`;
        resolve();
      });
    });

    // Create test user
    testUser = await storage.createUserWithDid(
      `privy-test-${Date.now()}`,
      `did:webvh:localhost%3A5000:testuser-${Date.now()}`,
      {
        didDocument: {
          '@context': ['https://www.w3.org/ns/did/v1'],
          id: `did:webvh:localhost%3A5000:testuser-${Date.now()}`,
        },
        didLog: [],
        didSlug: `testuser-${Date.now()}`,
        authWalletId: 'test-wallet-auth',
        assertionWalletId: 'test-wallet-assertion',
        updateWalletId: 'test-wallet-update',
        authKeyPublic: 'test-auth-key',
        assertionKeyPublic: 'test-assertion-key',
        updateKeyPublic: 'test-update-key',
        didCreatedAt: new Date(),
      }
    );

    // Reset mocks
    mockTestConnection.mockClear();
    mockGetFolderMetadata.mockClear();
    mockListImageFilesRecursive.mockClear();
    mockGetFileMetadata.mockClear();
    mockDownloadFile.mockClear();
  });

  afterEach(async () => {
    // Stop server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  describe('POST /api/import/google-drive/list-files', () => {
    it('should list files from Google Drive folder', async () => {
      const response = await fetch(`${serverUrl}/api/import/google-drive/list-files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderId: 'test-folder-123',
          accessToken: 'test-access-token',
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.folderName).toBe('Test Folder');
      expect(body.totalFiles).toBe(2);
      expect(body.files).toHaveLength(2);
      expect(body.files[0].name).toBe('photo1.jpg');
      expect(body.files[1].name).toBe('photo2.png');
    });

    it('should return 400 for missing fields', async () => {
      const response = await fetch(`${serverUrl}/api/import/google-drive/list-files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderId: 'test-folder-123',
          // Missing accessToken
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Missing required fields');
    });

    it('should return 401 for invalid access token', async () => {
      mockTestConnection.mockResolvedValueOnce(false);

      const response = await fetch(`${serverUrl}/api/import/google-drive/list-files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderId: 'test-folder-123',
          accessToken: 'invalid-token',
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toContain('Failed to authenticate');
    });

    it('should return 404 for folder not found', async () => {
      mockGetFolderMetadata.mockResolvedValueOnce(null);

      const response = await fetch(`${serverUrl}/api/import/google-drive/list-files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderId: 'non-existent-folder',
          accessToken: 'test-access-token',
        }),
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toContain('Folder not found');
    });

    it('should include errors from folder scanning', async () => {
      mockListImageFilesRecursive.mockResolvedValueOnce({
        files: [
          {
            id: 'img-1',
            name: 'photo1.jpg',
            mimeType: 'image/jpeg',
          },
        ],
        totalCount: 1,
        errors: [
          {
            folderId: 'subfolder-1',
            error: 'Permission denied',
          },
        ],
      });

      const response = await fetch(`${serverUrl}/api/import/google-drive/list-files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderId: 'test-folder-123',
          accessToken: 'test-access-token',
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].error).toContain('Permission denied');
    });
  });

  describe('POST /api/import/google-drive/start', () => {
    it('should start import process', async () => {
      const response = await fetch(`${serverUrl}/api/import/google-drive/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: testUser.id,
          folderId: 'test-folder-123',
          folderName: 'My Photos',
          accessToken: 'test-access-token',
          fileIds: ['img-1', 'img-2'],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.importId).toBeDefined();
      expect(body.totalFiles).toBe(2);
      expect(body.estimatedTime).toBeDefined();
      expect(body.message).toContain('Import started successfully');
    });

    it('should return 400 for missing fields', async () => {
      const response = await fetch(`${serverUrl}/api/import/google-drive/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: testUser.id,
          folderId: 'test-folder-123',
          // Missing folderName, accessToken, fileIds
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Missing required fields');
    });

    it('should return 400 for empty fileIds array', async () => {
      const response = await fetch(`${serverUrl}/api/import/google-drive/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: testUser.id,
          folderId: 'test-folder-123',
          folderName: 'My Photos',
          accessToken: 'test-access-token',
          fileIds: [],
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('non-empty array');
    });

    it('should return 404 for non-existent user', async () => {
      const response = await fetch(`${serverUrl}/api/import/google-drive/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'non-existent-user',
          folderId: 'test-folder-123',
          folderName: 'My Photos',
          accessToken: 'test-access-token',
          fileIds: ['img-1'],
        }),
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toContain('User not found');
    });

    it('should filter out files with metadata fetch errors', async () => {
      mockGetFileMetadata.mockImplementation(async (fileId: string) => {
        if (fileId === 'img-2') {
          throw new Error('File not found');
        }
        return {
          id: fileId,
          name: `file-${fileId}.jpg`,
          mimeType: 'image/jpeg',
        };
      });

      const response = await fetch(`${serverUrl}/api/import/google-drive/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: testUser.id,
          folderId: 'test-folder-123',
          folderName: 'My Photos',
          accessToken: 'test-access-token',
          fileIds: ['img-1', 'img-2'],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Only 1 valid file
      expect(body.totalFiles).toBe(1);
    });

    it('should return 400 if no valid files after filtering', async () => {
      mockGetFileMetadata.mockRejectedValue(new Error('File not found'));

      const response = await fetch(`${serverUrl}/api/import/google-drive/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: testUser.id,
          folderId: 'test-folder-123',
          folderName: 'My Photos',
          accessToken: 'test-access-token',
          fileIds: ['img-1', 'img-2'],
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('No valid files to import');
    });
  });

  describe('GET /api/import/google-drive/status/:importId', () => {
    it('should return import status', async () => {
      // First, start an import
      const startResponse = await fetch(`${serverUrl}/api/import/google-drive/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: testUser.id,
          folderId: 'test-folder-123',
          folderName: 'My Photos',
          accessToken: 'test-access-token',
          fileIds: ['img-1', 'img-2'],
        }),
      });

      const startBody = await startResponse.json();
      const importId = startBody.importId;

      // Then, check status
      const statusResponse = await fetch(
        `${serverUrl}/api/import/google-drive/status/${importId}`
      );

      expect(statusResponse.status).toBe(200);
      const statusBody = await statusResponse.json();

      expect(statusBody.importId).toBe(importId);
      expect(statusBody.status).toBeDefined();
      expect(statusBody.progress).toBeDefined();
      expect(statusBody.totalFiles).toBe(2);
      expect(statusBody.folderName).toBe('My Photos');
    });

    it('should return 404 for non-existent import', async () => {
      const response = await fetch(
        `${serverUrl}/api/import/google-drive/status/non-existent-import`
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toContain('Import not found');
    });

    it('should calculate progress correctly', async () => {
      const startResponse = await fetch(`${serverUrl}/api/import/google-drive/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: testUser.id,
          folderId: 'test-folder-123',
          folderName: 'My Photos',
          accessToken: 'test-access-token',
          fileIds: ['img-1', 'img-2'],
        }),
      });

      const startBody = await startResponse.json();
      const importId = startBody.importId;

      // Wait a bit for processing
      await new Promise(resolve => setTimeout(resolve, 500));

      const statusResponse = await fetch(
        `${serverUrl}/api/import/google-drive/status/${importId}`
      );

      const statusBody = await statusResponse.json();

      expect(statusBody.progress).toBeGreaterThanOrEqual(0);
      expect(statusBody.progress).toBeLessThanOrEqual(100);
    });
  });

  describe('End-to-End Import Flow', () => {
    it('should complete full import workflow', async () => {
      // 1. List files
      const listResponse = await fetch(`${serverUrl}/api/import/google-drive/list-files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderId: 'test-folder-123',
          accessToken: 'test-access-token',
        }),
      });

      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json();
      const fileIds = listBody.files.map((f: any) => f.id);

      // 2. Start import
      const startResponse = await fetch(`${serverUrl}/api/import/google-drive/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: testUser.id,
          folderId: 'test-folder-123',
          folderName: listBody.folderName,
          accessToken: 'test-access-token',
          fileIds,
        }),
      });

      expect(startResponse.status).toBe(200);
      const startBody = await startResponse.json();

      // 3. Poll status until complete
      let status = 'pending';
      let attempts = 0;
      const maxAttempts = 10;

      while (status !== 'completed' && status !== 'failed' && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 200));

        const statusResponse = await fetch(
          `${serverUrl}/api/import/google-drive/status/${startBody.importId}`
        );
        const statusBody = await statusResponse.json();
        status = statusBody.status;
        attempts++;
      }

      expect(status).toBe('completed');
    });
  });
});
