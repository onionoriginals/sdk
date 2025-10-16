import express, { type Request, type Response } from 'express';
import { storage } from '../storage';
import { createGoogleDriveClient } from '../services/googleDriveClient';
import { ImportProcessor } from '../services/importProcessor';
import { getOriginalsSDK } from '../originals';

const router = express.Router();

/**
 * POST /api/import/google-drive/list-files
 * List all image files in a Google Drive folder
 */
router.post('/google-drive/list-files', async (req: Request, res: Response) => {
  try {
    const { folderId, accessToken } = req.body;

    if (!folderId || !accessToken) {
      return res.status(400).json({
        error: 'Missing required fields: folderId, accessToken',
      });
    }

    // Create Drive client
    const driveClient = createGoogleDriveClient(accessToken);

    // Test connection
    const canConnect = await driveClient.testConnection();
    if (!canConnect) {
      return res.status(401).json({
        error: 'Failed to authenticate with Google Drive. Please re-authorize.',
      });
    }

    // Get folder metadata
    const folderMetadata = await driveClient.getFolderMetadata(folderId);
    if (!folderMetadata) {
      return res.status(404).json({
        error: 'Folder not found or you do not have access to it',
      });
    }

    // List files
    const filesResult = await driveClient.listImageFilesRecursive(folderId);

    if (filesResult.files.length === 0) {
      return res.status(200).json({
        folderName: folderMetadata.name,
        totalFiles: 0,
        files: [],
        message: 'No image files found in this folder',
      });
    }

    return res.status(200).json({
      folderName: folderMetadata.name,
      totalFiles: filesResult.totalCount,
      files: filesResult.files.map(f => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        thumbnailLink: f.thumbnailLink,
      })),
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

/**
 * POST /api/import/google-drive/start
 * Start importing files from a Google Drive folder
 */
router.post('/google-drive/start', async (req: Request, res: Response) => {
  try {
    const { userId, folderId, folderName, accessToken, files } = req.body;

    if (!userId || !folderId || !folderName || !accessToken || !files) {
      return res.status(400).json({
        error: 'Missing required fields: userId, folderId, folderName, accessToken, files',
      });
    }

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        error: 'Files must be a non-empty array',
      });
    }

    // Verify user exists
    const user = await storage.getUser(userId);
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    // Create Drive client
    const driveClient = createGoogleDriveClient(accessToken);

    // Get SDK instance for user
    const sdk = await getOriginalsSDK(userId);

    // Create import processor
    const processor = new ImportProcessor(driveClient, sdk, storage);

    // Start import with selected files
    const result = await processor.startImportWithFiles(
      userId,
      folderId,
      folderName,
      files
    );

    return res.status(200).json({
      importId: result.importId,
      totalFiles: result.totalFiles,
      estimatedTime: result.estimatedTime,
      message: 'Import started successfully',
    });
  } catch (error: any) {
    console.error('Error starting Google Drive import:', error);
    return res.status(500).json({
      error: 'Failed to start import',
      details: error.message,
    });
  }
});

/**
 * GET /api/import/google-drive/status/:importId
 * Get the status of an import
 */
router.get('/google-drive/status/:importId', async (req: Request, res: Response) => {
  try {
    const { importId } = req.params;

    if (!importId) {
      return res.status(400).json({
        error: 'Missing importId parameter',
      });
    }

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

/**
 * GET /api/import/google-drive/user/:userId
 * Get all imports for a user
 */
router.get('/google-drive/user/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        error: 'Missing userId parameter',
      });
    }

    const imports = await storage.getGoogleDriveImportsByUserId(userId);

    return res.status(200).json({
      imports: imports.map(imp => ({
        importId: imp.id,
        folderName: imp.folderName,
        status: imp.status,
        totalFiles: parseInt(imp.totalFiles || '0'),
        processedFiles: parseInt(imp.processedFiles || '0'),
        failedFiles: parseInt(imp.failedFiles || '0'),
        createdAt: imp.createdAt,
        completedAt: imp.completedAt,
      })),
    });
  } catch (error: any) {
    console.error('Error getting user imports:', error);
    return res.status(500).json({
      error: 'Failed to get user imports',
      details: error.message,
    });
  }
});

/**
 * DELETE /api/import/google-drive/cancel/:importId
 * Cancel an ongoing import
 */
router.delete('/google-drive/cancel/:importId', async (req: Request, res: Response) => {
  try {
    const { importId } = req.params;

    if (!importId) {
      return res.status(400).json({
        error: 'Missing importId parameter',
      });
    }

    const importRecord = await storage.getGoogleDriveImport(importId);

    if (!importRecord) {
      return res.status(404).json({
        error: 'Import not found',
      });
    }

    if (importRecord.status !== 'processing') {
      return res.status(400).json({
        error: 'Import is not currently processing',
        status: importRecord.status,
      });
    }

    await storage.updateGoogleDriveImport(importId, {
      status: 'failed',
      errorDetails: [{ fileId: 'system', fileName: 'system', error: 'Cancelled by user' }],
      completedAt: new Date(),
    });

    return res.status(200).json({
      message: 'Import cancelled successfully',
    });
  } catch (error: any) {
    console.error('Error cancelling import:', error);
    return res.status(500).json({
      error: 'Failed to cancel import',
      details: error.message,
    });
  }
});

export default router;

