import { google, drive_v3 } from 'googleapis';

/**
 * Google Drive file metadata for image imports
 */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  webViewLink?: string;
  webContentLink?: string;
  thumbnailLink?: string;
  parents?: string[];
}

/**
 * Result of file listing operation
 */
export interface ListFilesResult {
  files: DriveFile[];
  totalCount: number;
  errors: Array<{ folderId: string; error: string }>;
}

/**
 * Google Drive API client for importing files
 */
export class GoogleDriveClient {
  private drive: drive_v3.Drive;

  constructor(accessToken: string) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    this.drive = google.drive({ version: 'v3', auth });
  }

  /**
   * List all image files in a folder and its subfolders
   */
  async listImageFilesRecursive(folderId: string): Promise<ListFilesResult> {
    const files: DriveFile[] = [];
    const errors: Array<{ folderId: string; error: string }> = [];
    const processedFolders = new Set<string>();

    await this.listFilesInFolder(folderId, files, errors, processedFolders);

    return {
      files,
      totalCount: files.length,
      errors,
    };
  }

  /**
   * Recursively list files in a folder and its subfolders
   * Now with parallel subfolder scanning for better performance
   */
  private async listFilesInFolder(
    folderId: string,
    files: DriveFile[],
    errors: Array<{ folderId: string; error: string }>,
    processedFolders: Set<string>
  ): Promise<void> {
    // Prevent infinite loops from circular folder references
    if (processedFolders.has(folderId)) {
      return;
    }
    processedFolders.add(folderId);

    try {
      let pageToken: string | undefined = undefined;
      let response: any;
      const subfoldersToProcess: string[] = [];

      do {
        response = await this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, size, webViewLink, webContentLink, thumbnailLink, parents, capabilities/canDownload)',
          pageSize: 1000, // Increased from 100 to reduce API calls
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        const fileList = response.data.files || [];

        for (const file of fileList) {
          // Check if user has download permissions
          const canDownload = (file.capabilities as any)?.canDownload;
          
          if (!canDownload && !file.webViewLink) {
            // Skip files without access
            continue;
          }

          // If it's an image file, add to results
          if (file.mimeType?.startsWith('image/')) {
            files.push({
              id: file.id!,
              name: file.name!,
              mimeType: file.mimeType,
              size: file.size || undefined,
              webViewLink: file.webViewLink || undefined,
              webContentLink: file.webContentLink || undefined,
              thumbnailLink: file.thumbnailLink || undefined,
              parents: file.parents || undefined,
            });
          }
          // If it's a folder, add to list for parallel processing
          else if (file.mimeType === 'application/vnd.google-apps.folder') {
            subfoldersToProcess.push(file.id!);
          }
        }

        pageToken = response.data.nextPageToken || undefined;
      } while (pageToken);

      // Process subfolders in parallel (max 5 at a time to avoid rate limits)
      const batchSize = 5;
      for (let i = 0; i < subfoldersToProcess.length; i += batchSize) {
        const batch = subfoldersToProcess.slice(i, i + batchSize);
        await Promise.all(
          batch.map(subfolderId =>
            this.listFilesInFolder(subfolderId, files, errors, processedFolders)
          )
        );
      }
    } catch (error: any) {
      errors.push({
        folderId,
        error: error.message || 'Unknown error listing folder',
      });
    }
  }

  /**
   * Get metadata for a single file
   */
  async getFileMetadata(fileId: string): Promise<DriveFile | null> {
    try {
      const response = await this.drive.files.get({
        fileId,
        fields: 'id, name, mimeType, size, webViewLink, webContentLink, thumbnailLink, parents',
        supportsAllDrives: true,
      });

      const file = response.data;
      return {
        id: file.id!,
        name: file.name!,
        mimeType: file.mimeType!,
        size: file.size ?? undefined,
        webViewLink: file.webViewLink ?? undefined,
        webContentLink: file.webContentLink ?? undefined,
        thumbnailLink: file.thumbnailLink ?? undefined,
        parents: file.parents ?? undefined,
      };
    } catch (error: any) {
      console.error(`Error getting file metadata for ${fileId}:`, error);
      return null;
    }
  }

  /**
   * Get folder metadata
   */
  async getFolderMetadata(folderId: string): Promise<{ id: string; name: string } | null> {
    try {
      const response = await this.drive.files.get({
        fileId: folderId,
        fields: 'id, name',
        supportsAllDrives: true,
      });

      return {
        id: response.data.id!,
        name: response.data.name!,
      };
    } catch (error: any) {
      console.error(`Error getting folder metadata for ${folderId}:`, error);
      return null;
    }
  }

  /**
   * Check if a file ID is a folder
   */
  async isFolder(fileId: string): Promise<boolean> {
    try {
      const response = await this.drive.files.get({
        fileId,
        fields: 'mimeType',
        supportsAllDrives: true,
      });

      return response.data.mimeType === 'application/vnd.google-apps.folder';
    } catch (error) {
      return false;
    }
  }

  /**
   * Test connection by attempting to list files from root
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.drive.files.list({
        pageSize: 1,
        fields: 'files(id)',
      });
      return true;
    } catch (error) {
      return false;
    }
  }
}

/**
 * Create a Google Drive client from OAuth credentials
 */
export function createGoogleDriveClient(accessToken: string): GoogleDriveClient {
  return new GoogleDriveClient(accessToken);
}

