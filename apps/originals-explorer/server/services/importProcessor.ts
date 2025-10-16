import type { OriginalsSDK } from '@originals/sdk';
import type { IStorage } from '../storage';
import { GoogleDriveClient, type ListFilesResult } from './googleDriveClient';
import { processDriveFilesBatch, type BatchProcessingResult, type BatchProcessingOptions } from './batchDidCreator';

/**
 * Import status update callback
 */
export type ImportProgressCallback = (data: {
  importId: string;
  processed: number;
  total: number;
  successful: number;
  failed: number;
  currentFile?: string;
}) => void;

/**
 * Complete import orchestration service
 */
export class ImportProcessor {
  constructor(
    private driveClient: GoogleDriveClient,
    private sdk: OriginalsSDK,
    private storage: IStorage
  ) {}

  /**
   * Start a new import from a Google Drive folder
   */
  async startImport(
    userId: string,
    folderId: string,
    folderName: string,
    onProgress?: ImportProgressCallback
  ): Promise<{
    importId: string;
    totalFiles: number;
    estimatedTime: number;
  }> {
    // List all image files in the folder
    const filesResult = await this.driveClient.listImageFilesRecursive(folderId);

    if (filesResult.files.length === 0) {
      throw new Error('No image files found in the selected folder');
    }

    // Create import record
    const importRecord = await this.storage.createGoogleDriveImport({
      userId,
      folderId,
      folderName,
      status: 'pending',
      totalFiles: filesResult.files.length.toString(),
      processedFiles: '0',
      failedFiles: '0',
    });

    // Estimate processing time (500ms per file average)
    const estimatedTime = Math.ceil((filesResult.files.length * 500) / 1000);

    // Start processing in background (don't await)
    this.processImportInBackground(
      importRecord.id,
      userId,
      filesResult,
      onProgress
    ).catch(error => {
      console.error(`Import ${importRecord.id} failed:`, error);
      this.storage.updateGoogleDriveImport(importRecord.id, {
        status: 'failed',
        errorDetails: [{ fileId: 'system', fileName: 'system', error: error.message }],
        completedAt: new Date(),
      });
    });

    return {
      importId: importRecord.id,
      totalFiles: filesResult.files.length,
      estimatedTime,
    };
  }

  /**
   * Start import with pre-selected files (from UI)
   */
  async startImportWithFiles(
    userId: string,
    folderId: string,
    folderName: string,
    files: any[],
    onProgress?: ImportProgressCallback
  ): Promise<{
    importId: string;
    totalFiles: number;
    estimatedTime: number;
  }> {
    if (files.length === 0) {
      throw new Error('No files selected for import');
    }

    // Create import record
    const importRecord = await this.storage.createGoogleDriveImport({
      userId,
      folderId,
      folderName,
      status: 'pending',
      totalFiles: files.length.toString(),
      processedFiles: '0',
      failedFiles: '0',
    });

    // Estimate processing time (500ms per file average)
    const estimatedTime = Math.ceil((files.length * 500) / 1000);

    // Start processing in background with the provided files
    const filesResult: ListFilesResult = {
      files,
      totalCount: files.length,
      errors: [],
    };

    this.processImportInBackground(
      importRecord.id,
      userId,
      filesResult,
      onProgress
    ).catch(error => {
      console.error(`Import ${importRecord.id} failed:`, error);
      this.storage.updateGoogleDriveImport(importRecord.id, {
        status: 'failed',
        errorDetails: [{ fileId: 'system', fileName: 'system', error: error.message }],
        completedAt: new Date(),
      });
    });

    return {
      importId: importRecord.id,
      totalFiles: files.length,
      estimatedTime,
    };
  }

  /**
   * Process import in the background
   */
  private async processImportInBackground(
    importId: string,
    userId: string,
    filesResult: ListFilesResult,
    onProgress?: ImportProgressCallback
  ): Promise<void> {
    // Update status to processing
    await this.storage.updateGoogleDriveImport(importId, {
      status: 'processing',
    });

    // Process files in batches
    const batchOptions: BatchProcessingOptions = {
      batchSize: 10,
      onProgress: (current, total, file) => {
        // Update database progress
        this.storage.updateGoogleDriveImport(importId, {
          processedFiles: current.toString(),
        });

        // Call progress callback
        if (onProgress) {
          onProgress({
            importId,
            processed: current,
            total,
            successful: current, // Approximation
            failed: 0,
            currentFile: file.name,
          });
        }
      },
      onError: (file, error) => {
        console.error(`Failed to process file ${file.name}:`, error);
      },
    };

    const result = await processDriveFilesBatch(
      filesResult.files,
      this.sdk,
      userId,
      importId,
      this.storage,
      batchOptions
    );

    // Update import record with final results
    await this.storage.updateGoogleDriveImport(importId, {
      status: 'completed',
      processedFiles: result.totalProcessed.toString(),
      failedFiles: result.failed.length.toString(),
      errorDetails: result.failed.map(f => ({
        fileId: f.file.id,
        fileName: f.file.name,
        error: f.error || 'Unknown error',
      })),
      completedAt: new Date(),
    });

    // Final progress callback
    if (onProgress) {
      onProgress({
        importId,
        processed: result.totalProcessed,
        total: filesResult.files.length,
        successful: result.successful.length,
        failed: result.failed.length,
      });
    }
  }

  /**
   * Get import status
   */
  async getImportStatus(importId: string): Promise<{
    status: string;
    progress: number;
    totalFiles: number;
    processedFiles: number;
    failedFiles: number;
    errors?: Array<{ fileId: string; fileName: string; error: string }>;
  } | null> {
    const importRecord = await this.storage.getGoogleDriveImport(importId);
    
    if (!importRecord) {
      return null;
    }

    const totalFiles = parseInt(importRecord.totalFiles || '0');
    const processedFiles = parseInt(importRecord.processedFiles || '0');
    const failedFiles = parseInt(importRecord.failedFiles || '0');
    const progress = totalFiles > 0 ? (processedFiles / totalFiles) * 100 : 0;

    return {
      status: importRecord.status,
      progress: Math.round(progress),
      totalFiles,
      processedFiles,
      failedFiles,
      errors: importRecord.errorDetails as any,
    };
  }

  /**
   * Get all imports for a user
   */
  async getUserImports(userId: string) {
    return this.storage.getGoogleDriveImportsByUserId(userId);
  }

  /**
   * Cancel an ongoing import
   */
  async cancelImport(importId: string): Promise<boolean> {
    const importRecord = await this.storage.getGoogleDriveImport(importId);
    
    if (!importRecord || importRecord.status !== 'processing') {
      return false;
    }

    await this.storage.updateGoogleDriveImport(importId, {
      status: 'failed',
      errorDetails: [{ fileId: 'system', fileName: 'system', error: 'Import cancelled by user' }],
      completedAt: new Date(),
    });

    return true;
  }
}

