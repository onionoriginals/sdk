import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { GoogleDriveClient } from '../services/googleDriveClient';
import { google } from 'googleapis';

// Mock googleapis module
const mockListFiles = mock(async () => ({
  data: {
    files: [],
    nextPageToken: undefined,
  },
}));

const mockGetFile = mock(async () => ({
  data: {
    id: 'test-file-id',
    name: 'test.png',
    mimeType: 'image/png',
    size: '1024',
    webViewLink: 'https://drive.google.com/file/d/test-file-id/view',
  },
}));

const mockDownloadFile = mock(async () => ({
  data: Buffer.from('fake-image-data'),
}));

mock.module('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class MockOAuth2 {
        setCredentials() {}
      },
    },
    drive: () => ({
      files: {
        list: mockListFiles,
        get: mockGetFile,
      },
    }),
  },
}));

describe('GoogleDriveClient', () => {
  let client: GoogleDriveClient;
  const testAccessToken = 'test-access-token';

  beforeEach(() => {
    client = new GoogleDriveClient(testAccessToken);
    mockListFiles.mockClear();
    mockGetFile.mockClear();
    mockDownloadFile.mockClear();
  });

  describe('listImageFilesRecursive', () => {
    it('should list image files in a folder', async () => {
      mockListFiles.mockResolvedValueOnce({
        data: {
          files: [
            {
              id: 'img-1',
              name: 'photo1.jpg',
              mimeType: 'image/jpeg',
              size: '2048',
              capabilities: { canDownload: true },
            },
            {
              id: 'img-2',
              name: 'photo2.png',
              mimeType: 'image/png',
              size: '1024',
              capabilities: { canDownload: true },
            },
          ],
          nextPageToken: undefined,
        },
      });

      const result = await client.listImageFilesRecursive('test-folder-id');

      expect(result.files).toHaveLength(2);
      expect(result.totalCount).toBe(2);
      expect(result.files[0].name).toBe('photo1.jpg');
      expect(result.files[1].name).toBe('photo2.png');
    });

    it('should filter out non-image files', async () => {
      mockListFiles.mockResolvedValueOnce({
        data: {
          files: [
            {
              id: 'img-1',
              name: 'photo.jpg',
              mimeType: 'image/jpeg',
              capabilities: { canDownload: true },
            },
            {
              id: 'doc-1',
              name: 'document.pdf',
              mimeType: 'application/pdf',
              capabilities: { canDownload: true },
            },
          ],
          nextPageToken: undefined,
        },
      });

      const result = await client.listImageFilesRecursive('test-folder-id');

      expect(result.files).toHaveLength(1);
      expect(result.files[0].mimeType).toBe('image/jpeg');
    });

    it('should handle pagination correctly', async () => {
      mockListFiles
        .mockResolvedValueOnce({
          data: {
            files: [
              {
                id: 'img-1',
                name: 'photo1.jpg',
                mimeType: 'image/jpeg',
                capabilities: { canDownload: true },
              },
            ],
            nextPageToken: 'page2',
          },
        })
        .mockResolvedValueOnce({
          data: {
            files: [
              {
                id: 'img-2',
                name: 'photo2.jpg',
                mimeType: 'image/jpeg',
                capabilities: { canDownload: true },
              },
            ],
            nextPageToken: undefined,
          },
        });

      const result = await client.listImageFilesRecursive('test-folder-id');

      expect(result.files).toHaveLength(2);
      expect(mockListFiles).toHaveBeenCalledTimes(2);
    });

    it('should recursively scan subfolders', async () => {
      mockListFiles
        .mockResolvedValueOnce({
          data: {
            files: [
              {
                id: 'img-1',
                name: 'photo.jpg',
                mimeType: 'image/jpeg',
                capabilities: { canDownload: true },
              },
              {
                id: 'subfolder-1',
                name: 'Subfolder',
                mimeType: 'application/vnd.google-apps.folder',
                capabilities: { canDownload: true },
              },
            ],
            nextPageToken: undefined,
          },
        })
        .mockResolvedValueOnce({
          data: {
            files: [
              {
                id: 'img-2',
                name: 'nested.png',
                mimeType: 'image/png',
                capabilities: { canDownload: true },
              },
            ],
            nextPageToken: undefined,
          },
        });

      const result = await client.listImageFilesRecursive('test-folder-id');

      expect(result.files).toHaveLength(2);
      expect(result.files.some(f => f.name === 'photo.jpg')).toBe(true);
      expect(result.files.some(f => f.name === 'nested.png')).toBe(true);
    });

    it('should prevent circular folder references', async () => {
      let callCount = 0;
      mockListFiles.mockImplementation(async () => {
        callCount++;
        if (callCount > 10) {
          throw new Error('Infinite loop detected');
        }
        return {
          data: {
            files: [
              {
                id: 'circular-folder',
                name: 'Circular',
                mimeType: 'application/vnd.google-apps.folder',
                capabilities: { canDownload: true },
              },
            ],
            nextPageToken: undefined,
          },
        };
      });

      const result = await client.listImageFilesRecursive('circular-folder');

      expect(callCount).toBeLessThan(10);
      expect(result.files).toHaveLength(0);
    });

    it('should skip files without download permissions', async () => {
      mockListFiles.mockResolvedValueOnce({
        data: {
          files: [
            {
              id: 'img-1',
              name: 'accessible.jpg',
              mimeType: 'image/jpeg',
              capabilities: { canDownload: true },
            },
            {
              id: 'img-2',
              name: 'restricted.jpg',
              mimeType: 'image/jpeg',
              capabilities: { canDownload: false },
            },
          ],
          nextPageToken: undefined,
        },
      });

      const result = await client.listImageFilesRecursive('test-folder-id');

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('accessible.jpg');
    });

    it('should collect errors from failed folder scans', async () => {
      mockListFiles
        .mockResolvedValueOnce({
          data: {
            files: [
              {
                id: 'subfolder-1',
                name: 'Subfolder',
                mimeType: 'application/vnd.google-apps.folder',
                capabilities: { canDownload: true },
              },
            ],
            nextPageToken: undefined,
          },
        })
        .mockRejectedValueOnce(new Error('Permission denied'));

      const result = await client.listImageFilesRecursive('test-folder-id');

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('Permission denied');
    });
  });

  describe('getFileMetadata', () => {
    it('should fetch file metadata successfully', async () => {
      mockGetFile.mockResolvedValueOnce({
        data: {
          id: 'file-123',
          name: 'test.jpg',
          mimeType: 'image/jpeg',
          size: '2048',
          webViewLink: 'https://drive.google.com/file/d/file-123/view',
        },
      });

      const metadata = await client.getFileMetadata('file-123');

      expect(metadata).not.toBeNull();
      expect(metadata?.id).toBe('file-123');
      expect(metadata?.name).toBe('test.jpg');
      expect(metadata?.mimeType).toBe('image/jpeg');
    });

    it('should return null on error', async () => {
      mockGetFile.mockRejectedValueOnce(new Error('File not found'));

      const metadata = await client.getFileMetadata('non-existent');

      expect(metadata).toBeNull();
    });
  });

  describe('getFolderMetadata', () => {
    it('should fetch folder metadata successfully', async () => {
      mockGetFile.mockResolvedValueOnce({
        data: {
          id: 'folder-123',
          name: 'My Photos',
        },
      });

      const metadata = await client.getFolderMetadata('folder-123');

      expect(metadata).not.toBeNull();
      expect(metadata?.id).toBe('folder-123');
      expect(metadata?.name).toBe('My Photos');
    });

    it('should return null on error', async () => {
      mockGetFile.mockRejectedValueOnce(new Error('Folder not found'));

      const metadata = await client.getFolderMetadata('non-existent');

      expect(metadata).toBeNull();
    });
  });

  describe('testConnection', () => {
    it('should return true on successful connection', async () => {
      mockListFiles.mockResolvedValueOnce({
        data: {
          files: [],
        },
      });

      const result = await client.testConnection();

      expect(result).toBe(true);
    });

    it('should return false on failed connection', async () => {
      mockListFiles.mockRejectedValueOnce(new Error('Invalid credentials'));

      const result = await client.testConnection();

      expect(result).toBe(false);
    });
  });

  describe('downloadFile', () => {
    it('should download file as buffer', async () => {
      const mockBuffer = Buffer.from('fake-image-data');
      mockGetFile.mockResolvedValueOnce({
        data: mockBuffer,
      });

      const buffer = await client.downloadFile('file-123');

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString()).toBe('fake-image-data');
    });

    it('should throw error on download failure', async () => {
      mockGetFile.mockRejectedValueOnce(new Error('Download failed'));

      await expect(client.downloadFile('file-123')).rejects.toThrow(
        'Failed to download file file-123'
      );
    });
  });

  describe('getFileDownloadLink', () => {
    it('should return download link', async () => {
      mockGetFile.mockResolvedValueOnce({
        data: {
          webContentLink: 'https://drive.google.com/uc?id=file-123',
        },
      });

      const link = await client.getFileDownloadLink('file-123');

      expect(link).toBe('https://drive.google.com/uc?id=file-123');
    });

    it('should return null if no download link', async () => {
      mockGetFile.mockResolvedValueOnce({
        data: {},
      });

      const link = await client.getFileDownloadLink('file-123');

      expect(link).toBeNull();
    });

    it('should return null on error', async () => {
      mockGetFile.mockRejectedValueOnce(new Error('Failed'));

      const link = await client.getFileDownloadLink('file-123');

      expect(link).toBeNull();
    });
  });

  describe('isFolder', () => {
    it('should return true for folders', async () => {
      mockGetFile.mockResolvedValueOnce({
        data: {
          mimeType: 'application/vnd.google-apps.folder',
        },
      });

      const result = await client.isFolder('folder-123');

      expect(result).toBe(true);
    });

    it('should return false for files', async () => {
      mockGetFile.mockResolvedValueOnce({
        data: {
          mimeType: 'image/jpeg',
        },
      });

      const result = await client.isFolder('file-123');

      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      mockGetFile.mockRejectedValueOnce(new Error('Not found'));

      const result = await client.isFolder('non-existent');

      expect(result).toBe(false);
    });
  });
});
