import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { generateDidPeerForDriveFile } from '../services/didPeerGenerator';
import type { DriveFile, GoogleDriveClient } from '../services/googleDriveClient';
import type { OriginalsSDK } from '@originals/sdk';

describe('generateDidPeerForDriveFile', () => {
  let mockDriveClient: GoogleDriveClient;
  let mockSdk: OriginalsSDK;
  let testFile: DriveFile;

  beforeEach(() => {
    // Create test file metadata
    testFile = {
      id: 'test-file-123',
      name: 'test-image.jpg',
      mimeType: 'image/jpeg',
      size: '2048',
      webViewLink: 'https://drive.google.com/file/d/test-file-123/view',
      webContentLink: 'https://drive.google.com/uc?id=test-file-123',
      thumbnailLink: 'https://drive.google.com/thumbnail?id=test-file-123',
    };

    // Mock Drive client
    mockDriveClient = {
      downloadFile: mock(async (fileId: string) => {
        return Buffer.from('fake-image-data-' + fileId);
      }),
    } as any;

    // Mock SDK
    mockSdk = {
      lifecycle: {
        createAsset: mock(async (resources: any[]) => {
          return {
            id: 'did:peer:test123',
            did: {
              '@context': ['https://www.w3.org/ns/did/v1'],
              id: 'did:peer:test123',
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
  });

  it('should generate DID:Peer for a Google Drive file', async () => {
    const result = await generateDidPeerForDriveFile(testFile, mockSdk, mockDriveClient);

    expect(result.did).toBe('did:peer:test123');
    expect(result.didDocument).toBeDefined();
    expect(result.didDocument.id).toBe('did:peer:test123');
    expect(result.resources).toHaveLength(2);
    expect(result.fileMetadata).toEqual(testFile);
  });

  it('should create image and metadata resources', async () => {
    const result = await generateDidPeerForDriveFile(testFile, mockSdk, mockDriveClient);

    const imageResource = result.resources.find(r => r.type === 'Image');
    const metadataResource = result.resources.find(r => r.type === 'Metadata');

    expect(imageResource).toBeDefined();
    expect(imageResource?.contentType).toBe('image/jpeg');
    expect(imageResource?.id).toBe('image-test-file-123');

    expect(metadataResource).toBeDefined();
    expect(metadataResource?.contentType).toBe('application/json');
    expect(metadataResource?.id).toBe('metadata-test-file-123');
  });

  it('should download file and compute hash', async () => {
    await generateDidPeerForDriveFile(testFile, mockSdk, mockDriveClient);

    expect(mockDriveClient.downloadFile).toHaveBeenCalledWith('test-file-123');
  });

  it('should include Google Drive metadata in resources', async () => {
    const result = await generateDidPeerForDriveFile(testFile, mockSdk, mockDriveClient);

    const metadataResource = result.resources.find(r => r.type === 'Metadata');
    expect(metadataResource).toBeDefined();

    // The content is stored as JSON string in the resource
    const createAssetCall = (mockSdk.lifecycle.createAsset as any).mock.calls[0][0];
    const metadataFromCall = createAssetCall.find((r: any) => r.type === 'Metadata');
    const metadata = JSON.parse(metadataFromCall.content);

    expect(metadata.name).toBe('test-image.jpg');
    expect(metadata.source).toBe('google-drive');
    expect(metadata.googleDriveFileId).toBe('test-file-123');
    expect(metadata.mimeType).toBe('image/jpeg');
    expect(metadata.webViewLink).toBe('https://drive.google.com/file/d/test-file-123/view');
  });

  it('should encode image as base64', async () => {
    await generateDidPeerForDriveFile(testFile, mockSdk, mockDriveClient);

    const createAssetCall = (mockSdk.lifecycle.createAsset as any).mock.calls[0][0];
    const imageResource = createAssetCall.find((r: any) => r.type === 'Image');

    expect(imageResource.content).toBeDefined();
    // Check that it's base64 encoded
    const decoded = Buffer.from(imageResource.content, 'base64');
    expect(decoded.toString()).toContain('fake-image-data');
  });

  it('should handle download errors gracefully', async () => {
    mockDriveClient.downloadFile = mock(async () => {
      throw new Error('Download failed: Network error');
    });

    await expect(
      generateDidPeerForDriveFile(testFile, mockSdk, mockDriveClient)
    ).rejects.toThrow('Failed to generate DID:Peer for file test-image.jpg');
  });

  it('should handle SDK errors gracefully', async () => {
    mockSdk.lifecycle.createAsset = mock(async () => {
      throw new Error('SDK error: Invalid resource');
    });

    await expect(
      generateDidPeerForDriveFile(testFile, mockSdk, mockDriveClient)
    ).rejects.toThrow('Failed to generate DID:Peer for file test-image.jpg');
  });

  it('should compute SHA-256 hash of image', async () => {
    const testBuffer = Buffer.from('test-image-content');
    mockDriveClient.downloadFile = mock(async () => testBuffer);

    await generateDidPeerForDriveFile(testFile, mockSdk, mockDriveClient);

    const createAssetCall = (mockSdk.lifecycle.createAsset as any).mock.calls[0][0];
    const imageResource = createAssetCall.find((r: any) => r.type === 'Image');

    expect(imageResource.hash).toBeDefined();
    expect(imageResource.hash).toHaveLength(64); // SHA-256 hex string
  });

  it('should handle files without optional metadata fields', async () => {
    const minimalFile: DriveFile = {
      id: 'minimal-123',
      name: 'minimal.png',
      mimeType: 'image/png',
    };

    const result = await generateDidPeerForDriveFile(minimalFile, mockSdk, mockDriveClient);

    expect(result.did).toBeDefined();
    expect(result.resources).toHaveLength(2);

    const createAssetCall = (mockSdk.lifecycle.createAsset as any).mock.calls[0][0];
    const metadataFromCall = createAssetCall.find((r: any) => r.type === 'Metadata');
    const metadata = JSON.parse(metadataFromCall.content);

    expect(metadata.googleDriveFileId).toBe('minimal-123');
    expect(metadata.size).toBeUndefined();
    expect(metadata.webViewLink).toBeUndefined();
  });

  it('should handle different image mime types', async () => {
    const imageTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/svg+xml',
    ];

    for (const mimeType of imageTypes) {
      const file: DriveFile = {
        id: `file-${mimeType}`,
        name: `test.${mimeType.split('/')[1]}`,
        mimeType,
      };

      const result = await generateDidPeerForDriveFile(file, mockSdk, mockDriveClient);

      const imageResource = result.resources.find(r => r.type === 'Image');
      expect(imageResource?.contentType).toBe(mimeType);
    }
  });

  it('should include original hash in metadata', async () => {
    await generateDidPeerForDriveFile(testFile, mockSdk, mockDriveClient);

    const createAssetCall = (mockSdk.lifecycle.createAsset as any).mock.calls[0][0];
    const metadataFromCall = createAssetCall.find((r: any) => r.type === 'Metadata');
    const metadata = JSON.parse(metadataFromCall.content);

    expect(metadata.originalHash).toBeDefined();
    expect(metadata.originalHash).toHaveLength(64); // SHA-256 hex
  });

  it('should set description indicating Google Drive import', async () => {
    await generateDidPeerForDriveFile(testFile, mockSdk, mockDriveClient);

    const createAssetCall = (mockSdk.lifecycle.createAsset as any).mock.calls[0][0];
    const metadataFromCall = createAssetCall.find((r: any) => r.type === 'Metadata');
    const metadata = JSON.parse(metadataFromCall.content);

    expect(metadata.description).toContain('Imported from Google Drive');
  });
});
