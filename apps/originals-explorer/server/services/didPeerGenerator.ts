import { OriginalsSDK } from '@originals/sdk';
import type { DriveFile } from './googleDriveClient';

/**
 * DID:Peer result with metadata
 */
export interface DidPeerResult {
  did: string;
  didDocument: any;
  fileMetadata: DriveFile;
  publicKey: string;
  privateKey?: string;
}

/**
 * Generate DID:Peer for a Google Drive file
 */
export async function generateDidPeerForDriveFile(
  file: DriveFile,
  sdk: OriginalsSDK
): Promise<DidPeerResult> {
  try {
    // Create metadata JSON for the Google Drive file
    const metadata = {
      name: file.name,
      description: `Imported from Google Drive`,
      source: 'google-drive',
      googleDriveFileId: file.id,
      mimeType: file.mimeType,
      size: file.size,
      webViewLink: file.webViewLink,
      webContentLink: file.webContentLink,
      thumbnailLink: file.thumbnailLink,
    };
    
    const metadataString = JSON.stringify(metadata);
    
    // Create a simple hash (in production, use proper crypto hash)
    const crypto = await import('crypto');
    const metadataHash = crypto.createHash('sha256').update(metadataString).digest('hex');
    
    // Create resource array as expected by SDK
    const resources = [{
      id: `google-drive-${file.id}`,
      type: 'GoogleDriveImage',
      contentType: 'application/json', // Metadata is JSON
      hash: metadataHash,
      content: metadataString,
      url: file.webViewLink || file.webContentLink, // Link to Google Drive
    }];

    // Create asset with SDK
    const originalsAsset = await sdk.lifecycle.createAsset(resources);

    return {
      did: originalsAsset.id,
      didDocument: (originalsAsset as any).didDocument || {},
      fileMetadata: file,
      publicKey: '', // SDK handles keys internally
    };
  } catch (error: any) {
    throw new Error(`Failed to generate DID:Peer for file ${file.name}: ${error.message}`);
  }
}

/**
 * Generate DID document with Google Drive service endpoints
 */
export function createDidDocumentWithDriveReference(
  did: string,
  file: DriveFile,
  publicKeyMultibase: string
): any {
  const didDocument: any = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
    ],
    id: did,
    verificationMethod: [
      {
        id: `${did}#key-1`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase,
      },
    ],
    authentication: [`${did}#key-1`],
    assertionMethod: [`${did}#key-1`],
    service: [
      {
        id: `${did}#google-drive`,
        type: 'GoogleDriveFile',
        serviceEndpoint: {
          fileId: file.id,
          fileName: file.name,
          mimeType: file.mimeType,
          size: file.size,
          webViewLink: file.webViewLink,
          webContentLink: file.webContentLink,
          thumbnailLink: file.thumbnailLink,
        },
      },
    ],
  };

  return didDocument;
}

/**
 * Extract Google Drive metadata from a DID document
 */
export function extractDriveMetadataFromDidDocument(didDocument: any): Partial<DriveFile> | null {
  try {
    const driveService = didDocument.service?.find(
      (s: any) => s.type === 'GoogleDriveFile'
    );

    if (!driveService?.serviceEndpoint) {
      return null;
    }

    return {
      id: driveService.serviceEndpoint.fileId,
      name: driveService.serviceEndpoint.fileName,
      mimeType: driveService.serviceEndpoint.mimeType,
      size: driveService.serviceEndpoint.size,
      webViewLink: driveService.serviceEndpoint.webViewLink,
      webContentLink: driveService.serviceEndpoint.webContentLink,
      thumbnailLink: driveService.serviceEndpoint.thumbnailLink,
    };
  } catch (error) {
    return null;
  }
}

