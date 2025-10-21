import type { OriginalsSDK } from '@originals/sdk';
import type { IStorage } from '../storage';
import { GoogleDriveClient, type ListFilesResult, type DriveFile } from './googleDriveClient';
import { processDriveFilesBatch, type BatchProcessingOptions } from './batchDidCreator';

export class ImportProcessor {
  constructor(
    private driveClient: GoogleDriveClient,
    private sdk: OriginalsSDK,
    private storage: IStorage
  ) {}

  async startImportWithFiles(
    userId: string,
    folderId: string,
    folderName: string,
    files: DriveFile[]
  ): Promise<{
    importId: string;
    totalFiles: number;
    estimatedTime: number;
  }> {
    if (files.length === 0) {
      throw new Error('No files selected for import');
    }

    const importRecord = await this.storage.createGoogleDriveImport({
      userId,
      folderId,
      folderName,
      status: 'pending',
      totalFiles: files.length.toString(),
      processedFiles: '0',
      failedFiles: '0',
    });

    const estimatedTime = Math.ceil((files.length * 500) / 1000);

    const filesResult: ListFilesResult = {
      files,
      totalCount: files.length,
      errors: [],
    };

    this.processImportInBackground(importRecord.id, userId, filesResult).catch(error => {
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

  private async processImportInBackground(
    importId: string,
    userId: string,
    filesResult: ListFilesResult
  ): Promise<void> {
    await this.storage.updateGoogleDriveImport(importId, {
      status: 'processing',
    });

    const batchOptions: BatchProcessingOptions = {
      batchSize: 10,
      onProgress: (current, total, file) => {
        this.storage.updateGoogleDriveImport(importId, {
          processedFiles: current.toString(),
        });
      },
      onError: (file, error) => {
        console.error(`Failed to process file ${file.name}:`, error);
      },
    };

    const result = await processDriveFilesBatch(
      filesResult.files,
      this.sdk,
      this.driveClient,
      userId,
      importId,
      this.storage,
      batchOptions
    );

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
  }
}

