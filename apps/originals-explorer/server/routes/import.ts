import express, { type Request, type Response } from 'express';
import { storage } from '../storage';
import { createGoogleDriveClient } from '../services/googleDriveClient';
import { ImportProcessor } from '../services/importProcessor';
import { originalsSdk } from '../originals';

const router = express.Router();

router.post('/google-drive/list-files', async (req: Request, res: Response) => {
  try {
    const { folderId, accessToken } = req.body;

    if (!folderId || !accessToken) {
      return res.status(400).json({
        error: 'Missing required fields: folderId, accessToken',
      });
    }

    const driveClient = createGoogleDriveClient(accessToken);
    const canConnect = await driveClient.testConnection();
    
    if (!canConnect) {
      return res.status(401).json({
        error: 'Failed to authenticate with Google Drive',
      });
    }

    const folderMetadata = await driveClient.getFolderMetadata(folderId);
    if (!folderMetadata) {
      return res.status(404).json({
        error: 'Folder not found or you do not have access',
      });
    }

    const filesResult = await driveClient.listImageFilesRecursive(folderId);

    return res.status(200).json({
      folderName: folderMetadata.name,
      totalFiles: filesResult.totalCount,
      files: filesResult.files,
      errors: filesResult.errors,
    });
  } catch (error: any) {
    console.error('Error listing Google Drive files:', error);
    return res.status(500).json({
      error: 'Failed to list files from Google Drive',
      details: error.message,
    });
  }
});

router.post('/google-drive/start', async (req: Request, res: Response) => {
  try {
    const { userId, folderId, folderName, accessToken, fileIds } = req.body;

    if (!userId || !folderId || !folderName || !accessToken || !fileIds) {
      return res.status(400).json({
        error: 'Missing required fields',
      });
    }

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({
        error: 'fileIds must be a non-empty array',
      });
    }

    const user = await storage.getUser(userId);
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    const driveClient = createGoogleDriveClient(accessToken);
    
    // Fetch actual file metadata from Google Drive for each file ID
    console.log(`Fetching metadata for ${fileIds.length} files...`);
    const files = await Promise.all(
      fileIds.map(async (id: string) => {
        try {
          const metadata = await driveClient.getFileMetadata(id);
          if (!metadata) {
            throw new Error(`File ${id} not found`);
          }
          return metadata;
        } catch (error: any) {
          console.error(`Failed to fetch metadata for ${id}:`, error.message);
          // Return a placeholder with error info
          return {
            id,
            name: `unknown-${id}`,
            mimeType: 'application/octet-stream',
            error: error.message,
          };
        }
      })
    );

    // Filter out files that had errors
    const validFiles = files.filter(f => !(f as any).error);
    console.log(`Valid files: ${validFiles.length} of ${files.length}`);

    if (validFiles.length === 0) {
      return res.status(400).json({
        error: 'No valid files to import',
      });
    }

    const sdk = originalsSdk; // SDK is already an instance, not a factory function
    const processor = new ImportProcessor(driveClient, sdk, storage);

    const result = await processor.startImportWithFiles(
      userId,
      folderId,
      folderName,
      validFiles
    );

    return res.status(200).json({
      importId: result.importId,
      totalFiles: result.totalFiles,
      estimatedTime: result.estimatedTime,
      message: 'Import started successfully',
    });
  } catch (error: any) {
    console.error('Error starting import:', error);
    return res.status(500).json({
      error: 'Failed to start import',
      details: error.message,
    });
  }
});

router.get('/google-drive/status/:importId', async (req: Request, res: Response) => {
  try {
    const { importId } = req.params;

    const importRecord = await storage.getGoogleDriveImport(importId);

    if (!importRecord) {
      return res.status(404).json({
        error: 'Import not found',
      });
    }

    const totalFiles = parseInt(importRecord.totalFiles || '0');
    const processedFiles = parseInt(importRecord.processedFiles || '0');
    const failedFiles = parseInt(importRecord.failedFiles || '0');
    const progress = totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 0;

    return res.status(200).json({
      importId: importRecord.id,
      status: importRecord.status,
      progress,
      totalFiles,
      processedFiles,
      successfulFiles: processedFiles - failedFiles,
      failedFiles,
      folderName: importRecord.folderName,
      createdAt: importRecord.createdAt,
      completedAt: importRecord.completedAt,
      errors: importRecord.errorDetails || [],
    });
  } catch (error: any) {
    console.error('Error getting import status:', error);
    return res.status(500).json({
      error: 'Failed to get import status',
      details: error.message,
    });
  }
});

export default router;

