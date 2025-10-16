import type { OriginalsSDK } from '@originals/sdk';
import type { DriveFile } from './googleDriveClient';
import { generateDidPeerForDriveFile, type DidPeerResult } from './didPeerGenerator';

/**
 * Result of a single file processing
 */
export interface FileProcessingResult {
  success: boolean;
  file: DriveFile;
  did?: string;
  didDocument?: any;
  assetId?: string;
  error?: string;
}

/**
 * Result of batch processing
 */
export interface BatchProcessingResult {
  successful: FileProcessingResult[];
  failed: FileProcessingResult[];
  totalProcessed: number;
}

/**
 * Options for batch processing
 */
export interface BatchProcessingOptions {
  batchSize?: number; // Number of files to process in parallel
  onProgress?: (current: number, total: number, file: DriveFile) => void;
  onError?: (file: DriveFile, error: Error) => void;
}

/**
 * Process multiple Google Drive files and create DID:Peers in batches
 */
export async function processDriveFilesBatch(
  files: DriveFile[],
  sdk: OriginalsSDK,
  userId: string,
  importId: string,
  storage: any, // Will be typed properly when storage is updated
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

  // Process files in batches to avoid overwhelming the system
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    
    // Process batch in parallel
    const batchPromises = batch.map(async (file) => {
      try {
        // Report progress
        if (onProgress) {
          onProgress(processedCount + 1, files.length, file);
        }

        // Generate DID:Peer for the file
        const didResult = await generateDidPeerForDriveFile(file, sdk);

        // Store the asset in the database
        const assetId = await storage.createAssetFromGoogleDrive({
          userId,
          importId,
          title: file.name,
          didPeer: didResult.did,
          didDocument: didResult.didDocument,
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

    // Wait for batch to complete
    const batchResults = await Promise.all(batchPromises);

    // Separate successful and failed results
    for (const result of batchResults) {
      if (result.success) {
        successful.push(result);
      } else {
        failed.push(result);
      }
    }

    // Small delay between batches to avoid rate limiting
    if (i + batchSize < files.length) {
      await sleep(100);
    }
  }

  return {
    successful,
    failed,
    totalProcessed: processedCount,
  };
}

/**
 * Process a single file (wrapper for batch processing)
 */
export async function processSingleDriveFile(
  file: DriveFile,
  sdk: OriginalsSDK,
  userId: string,
  importId: string,
  storage: any
): Promise<FileProcessingResult> {
  const result = await processDriveFilesBatch(
    [file],
    sdk,
    userId,
    importId,
    storage,
    { batchSize: 1 }
  );

  return result.successful[0] || result.failed[0];
}

/**
 * Retry failed file processing
 */
export async function retryFailedFiles(
  failedResults: FileProcessingResult[],
  sdk: OriginalsSDK,
  userId: string,
  importId: string,
  storage: any,
  options: BatchProcessingOptions = {}
): Promise<BatchProcessingResult> {
  const files = failedResults.map(r => r.file);
  return processDriveFilesBatch(files, sdk, userId, importId, storage, options);
}

/**
 * Sleep utility for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Estimate processing time based on file count
 */
export function estimateProcessingTime(fileCount: number, batchSize: number = 10): number {
  // Assume ~500ms per file on average
  const timePerFile = 500;
  const batches = Math.ceil(fileCount / batchSize);
  const batchDelay = (batches - 1) * 100; // 100ms delay between batches
  
  return Math.ceil((fileCount * timePerFile + batchDelay) / 1000); // Return seconds
}

