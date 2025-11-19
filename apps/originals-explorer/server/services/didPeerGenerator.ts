import { OriginalsSDK } from '@originals/sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { DriveFile, GoogleDriveClient } from './googleDriveClient';

/**
 * DID:Peer result with metadata
 */
export interface DidPeerResult {
  did: string;
  didDocument: any;
  resources: any[];
  fileMetadata: DriveFile;
  publicKey: string;
}

/**
 * Generate DID:Peer for a Google Drive file with actual image resource
 */
export async function generateDidPeerForDriveFile(
  file: DriveFile,
  sdk: OriginalsSDK,
  driveClient: GoogleDriveClient
): Promise<DidPeerResult> {
  try {
    console.log(`[DIDPeerGenerator] Downloading ${file.name} (${file.id})...`);
    
    // Download the actual image file
    const imageBuffer = await driveClient.downloadFile(file.id);
    const imageHash = bytesToHex(sha256(imageBuffer instanceof Buffer ? new Uint8Array(imageBuffer) : imageBuffer));
    
    console.log(`[DIDPeerGenerator] Downloaded ${file.name}, size: ${imageBuffer.length} bytes, hash: ${imageHash.substring(0, 16)}...`);
    
    // Create metadata JSON for the Google Drive file
    const metadata = {
      name: file.name,
      description: `Imported from Google Drive`,
      source: 'google-drive',
      googleDriveFileId: file.id,
      mimeType: file.mimeType,
      size: file.size,
      originalHash: imageHash,
      webViewLink: file.webViewLink,
      webContentLink: file.webContentLink,
      thumbnailLink: file.thumbnailLink,
    };
    
    const metadataString = JSON.stringify(metadata);
    const metadataHash = bytesToHex(sha256(new TextEncoder().encode(metadataString)));
    
    // Create resource array with actual image data
    const resources = [
      // Main image resource
      {
        id: `image-${file.id}`,
        type: 'Image',
        contentType: file.mimeType,
        hash: imageHash,
        content: imageBuffer.toString('base64'), // Convert to base64 for SDK
        url: file.webViewLink || file.webContentLink,
      },
      // Metadata resource
      {
        id: `metadata-${file.id}`,
        type: 'Metadata',
        contentType: 'application/json',
        hash: metadataHash,
        content: metadataString,
      },
    ];

    console.log(`[DIDPeerGenerator] Creating DID:peer for ${file.name} with ${resources.length} resources...`);
    
    // Create asset with SDK
    const originalsAsset = await sdk.lifecycle.createAsset(resources);

    console.log(`[DIDPeerGenerator] ✅ Created DID:peer ${originalsAsset.id} for ${file.name}`);
    console.log(`[DIDPeerGenerator] Resources created:`, originalsAsset.resources.map(r => ({ id: r.id, type: r.type, hash: r.hash.substring(0, 16) })));

    return {
      did: originalsAsset.id,
      didDocument: originalsAsset.did,
      resources: originalsAsset.resources,
      fileMetadata: file,
      publicKey: '',
    };
  } catch (error: any) {
    console.error(`[DIDPeerGenerator] ❌ Failed for ${file.name}:`, error.message);
    throw new Error(`Failed to generate DID:Peer for file ${file.name}: ${error.message}`);
  }
}

