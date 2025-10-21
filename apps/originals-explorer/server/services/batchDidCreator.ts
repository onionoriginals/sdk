import type { OriginalsSDK } from '@originals/sdk';
import type { DriveFile, GoogleDriveClient } from './googleDriveClient';
import { generateDidPeerForDriveFile, type DidPeerResult } from './didPeerGenerator';

export interface FileProcessingResult {
  success: boolean;
  file: DriveFile;
  did?: string;
  didDocument?: any;
  assetId?: string;
  error?: string;
}

export interface BatchProcessingResult {
  successful: FileProcessingResult[];
  failed: FileProcessingResult[];
  totalProcessed: number;
}

export interface BatchProcessingOptions {
  batchSize?: number;
  onProgress?: (current: number, total: number, file: DriveFile) => void;
  onError?: (file: DriveFile, error: Error) => void;
}

export async function processDriveFilesBatch(
  files: DriveFile[],
  sdk: OriginalsSDK,
  driveClient: GoogleDriveClient,
  userId: string,
  importId: string,
  storage: any,
  options: BatchProcessingOptions = {}
): Promise<BatchProcessingResult> {
  const {
    batchSize = 10,
    onProgress,
    onError,
  } = options;

  const successful: FileProcessingResult[] = [];
  const failed: FileProcessingResult[] = [];
  let processedCount = 0;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    
    const batchPromises = batch.map(async (file) => {
      try {
        if (onProgress) {
          onProgress(processedCount + 1, files.length, file);
        }

        console.log(`[BatchProcessor] Processing file ${processedCount + 1}/${files.length}: ${file.name}`);

        const didResult = await generateDidPeerForDriveFile(file, sdk, driveClient);

        console.log(`[BatchProcessor] Storing asset with ${didResult.resources.length} resources`);

        // Store only resource metadata (without full content to avoid memory issues)
        const resourceMetadata = didResult.resources.map(r => ({
          id: r.id,
          type: r.type,
          contentType: r.contentType,
          hash: r.hash,
          url: r.url,
          // DO NOT store 'content' - it contains large base64 data
        }));

        const asset = await storage.createAssetFromGoogleDrive({
          userId,
          importId,
          title: file.name,
          didPeer: didResult.did,
          didDocument: didResult.didDocument,
          resources: resourceMetadata, // Only metadata, not full content
          sourceMetadata: {
            googleDriveFileId: file.id,
            fileName: file.name,
            mimeType: file.mimeType,
            size: file.size,
            webViewLink: file.webViewLink,
            webContentLink: file.webContentLink,
            thumbnailLink: file.thumbnailLink,
          },
        });

        const assetId = asset.id;

        processedCount++;

        return {
          success: true,
          file,
          did: didResult.did,
          didDocument: didResult.didDocument,
          assetId,
        } as FileProcessingResult;
      } catch (error: any) {
        processedCount++;

        if (onError) {
          onError(file, error);
        }

        return {
          success: false,
          file,
          error: error.message || 'Unknown error',
        } as FileProcessingResult;
      }
    });

    const batchResults = await Promise.all(batchPromises);

    for (const result of batchResults) {
      if (result.success) {
        successful.push(result);
      } else {
        failed.push(result);
      }
    }

    if (i + batchSize < files.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return {
    successful,
    failed,
    totalProcessed: processedCount,
  };
}

