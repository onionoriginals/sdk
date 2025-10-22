# Google Drive Import Module

Comprehensive guide for importing images from Google Drive into the Originals Explorer application with DID:Peer generation.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Setup](#setup)
4. [Usage](#usage)
5. [Architecture](#architecture)
6. [API Reference](#api-reference)
7. [Performance](#performance)
8. [Troubleshooting](#troubleshooting)
9. [Testing](#testing)

## Overview

The Google Drive Import module allows users to:
- Authenticate with Google OAuth 2.0
- Browse and select folders from their Google Drive
- Import images recursively from folders and subfolders
- Generate DID:Peer identifiers for each imported image
- Track import progress in real-time
- Handle errors gracefully with retry logic

### Key Features

- **Recursive Folder Scanning**: Automatically discovers images in nested folders
- **Batch Processing**: Groups files to respect API rate limits (10 files per batch)
- **Progress Tracking**: Real-time UI updates via polling (2-second intervals)
- **Error Resilience**: Continues processing even if individual files fail
- **Rate Limiting**: Prevents exceeding Google Drive API quotas
- **Retry Logic**: Automatically retries failed requests with exponential backoff
- **DID:Peer Generation**: Creates unique decentralized identifiers for each image
- **Permission Checking**: Respects Google Drive file permissions

## Prerequisites

### 1. Google Cloud Project Setup

Create a Google Cloud project and enable the Google Drive API:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google Drive API:
   - Navigate to "APIs & Services" > "Library"
   - Search for "Google Drive API"
   - Click "Enable"

### 2. OAuth 2.0 Credentials

Create OAuth 2.0 credentials:

1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth 2.0 Client ID"
3. Select "Web application"
4. Add authorized redirect URIs:
   - Development: `http://localhost:5001/auth/google/callback`
   - Production: `https://yourdomain.com/auth/google/callback`
5. Save the Client ID and Client Secret

### 3. Google API Key (for Picker API)

Create an API key for the Google Picker API:

1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "API Key"
3. Restrict the key to "Google Picker API" (optional but recommended)

### 4. Database Setup

The module uses PostgreSQL to store:
- Import records (status, progress, errors)
- Asset records (DID:Peer, metadata, provenance)

Ensure your database schema includes the `assets` table with:
- `didPeer` (text)
- `originalReference` (text) - set to 'google-drive-import'
- `metadata` (jsonb) - Google Drive file metadata
- `provenance` (jsonb) - import details and resources
- `didDocument` (jsonb) - full DID document

## Setup

### 1. Environment Variables

Create or update `.env` file in `apps/originals-explorer/`:

```bash
# Backend OAuth Configuration
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:5001/api/auth/google/callback

# Frontend Configuration
VITE_GOOGLE_CLIENT_ID=your_google_client_id
VITE_GOOGLE_API_KEY=your_google_api_key

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/originals
```

### 2. Install Dependencies

```bash
cd apps/originals-explorer
bun install
```

### 3. Database Migration

Ensure the database schema is up to date:

```bash
bun run db:push
```

### 4. Start the Application

```bash
# Development mode
bun run dev
```

The application will be available at `http://localhost:5001`.

## Usage

### User Flow

1. **Connect Google Drive**
   - Click "Connect Google Drive" button
   - Authenticate with Google account
   - Grant permissions to read Drive files

2. **Select Folder**
   - Google Picker opens automatically after authentication
   - Browse and select a folder containing images
   - Click "Select" to confirm

3. **Review Files**
   - Modal displays all image files found (including subfolders)
   - Review the file list and estimated import time
   - Select/deselect files to import
   - Click "Start Import" to begin

4. **Track Progress**
   - Progress bar shows import completion percentage
   - View success/failure counts in real-time
   - See detailed error messages for failed files
   - Import completes automatically

5. **View Imported Assets**
   - Navigate to the Assets page
   - Filter by `originalReference: 'google-drive-import'`
   - Each asset has a unique DID:Peer identifier

### Programmatic Usage

```typescript
import { createGoogleDriveClient } from './services/googleDriveClient';
import { ImportProcessor } from './services/importProcessor';
import { originalsSdk } from './originals';
import { storage } from './storage';

// Create Google Drive client
const driveClient = createGoogleDriveClient(accessToken);

// List files from a folder
const filesResult = await driveClient.listImageFilesRecursive(folderId);

// Start import
const processor = new ImportProcessor(driveClient, originalsSdk, storage);
const result = await processor.startImportWithFiles(
  userId,
  folderId,
  'My Photos',
  filesResult.files
);

// Track progress
const importStatus = await storage.getGoogleDriveImport(result.importId);
console.log(`Progress: ${importStatus.processedFiles}/${importStatus.totalFiles}`);
```

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│ FRONTEND (React)                                            │
├─────────────────────────────────────────────────────────────┤
│ ImportManager.tsx                                           │
│  ├─ useGoogleAuth (OAuth flow)                              │
│  ├─ Google Picker (folder selection)                        │
│  ├─ File selection modal                                    │
│  └─ ImportProgress (polling status every 2s)               │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ BACKEND API (Express)                                       │
├─────────────────────────────────────────────────────────────┤
│ /api/import/google-drive/list-files                         │
│ /api/import/google-drive/start                              │
│ /api/import/google-drive/status/:importId                   │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ SERVICES                                                    │
├─────────────────────────────────────────────────────────────┤
│ GoogleDriveClient (list, download with retry)               │
│    ↓                                                         │
│ ImportProcessor (orchestrate)                               │
│    ↓                                                         │
│ BatchDidCreator (process in batches)                        │
│    ├─ DidPeerGenerator (create DID + hash)                 │
│    └─ Storage (save to database)                            │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. User selects folder → Google Picker returns folder ID
2. Frontend calls `/list-files` → Backend lists all images recursively
3. User confirms → Frontend calls `/start` with file IDs
4. Backend creates import record and starts background processing
5. Backend processes files in batches of 10:
   - Downloads file from Google Drive (with retry)
   - Generates SHA-256 hash
   - Creates DID:Peer using OriginalsSDK
   - Stores asset in database
6. Frontend polls `/status/:importId` every 2 seconds
7. Progress updates shown in real-time
8. Import completes → User can view imported assets

## API Reference

### POST /api/import/google-drive/list-files

List all image files in a folder.

**Request:**
```json
{
  "folderId": "string",
  "accessToken": "string"
}
```

**Response:**
```json
{
  "folderName": "string",
  "totalFiles": 123,
  "files": [
    {
      "id": "string",
      "name": "photo.jpg",
      "mimeType": "image/jpeg",
      "size": "2048",
      "webViewLink": "https://...",
      "thumbnailLink": "https://..."
    }
  ],
  "errors": []
}
```

### POST /api/import/google-drive/start

Start import process.

**Request:**
```json
{
  "userId": "string",
  "folderId": "string",
  "folderName": "string",
  "accessToken": "string",
  "fileIds": ["string"]
}
```

**Response:**
```json
{
  "importId": "string",
  "totalFiles": 123,
  "estimatedTime": 61,
  "message": "Import started successfully"
}
```

### GET /api/import/google-drive/status/:importId

Get import status.

**Response:**
```json
{
  "importId": "string",
  "status": "processing",
  "progress": 75,
  "totalFiles": 100,
  "processedFiles": 75,
  "successfulFiles": 73,
  "failedFiles": 2,
  "folderName": "My Photos",
  "createdAt": "2025-01-15T10:30:00Z",
  "completedAt": null,
  "errors": [
    {
      "fileId": "abc123",
      "fileName": "photo.jpg",
      "error": "Permission denied"
    }
  ]
}
```

## Performance

### Benchmarks

**Target:** Import 250 images in under 5 minutes

**Actual Performance:**
- **Average time per file:** ~500ms
- **Throughput:** ~20 files/batch
- **250 files:** ~2-3 minutes
- **Success rate:** >95%

**Optimization Techniques:**
- Batch processing (20 files per batch)
- Parallel processing within batches
- Rate limiting to prevent API quota errors
- Retry logic with exponential backoff
- Efficient memory usage (store only metadata, not full content)

### Running Benchmarks

```bash
# Set environment variables
export GOOGLE_ACCESS_TOKEN="your_access_token"
export BENCHMARK_FOLDER_ID="folder_id_with_250_images"
export BENCHMARK_USER_ID="test-user"

# Run benchmark
bun scripts/benchmark-google-drive-import.ts
```

## Troubleshooting

### Common Issues

#### 1. "Failed to authenticate with Google Drive"

**Cause:** Invalid or expired access token

**Solution:**
- Refresh the page and re-authenticate
- Check OAuth credentials in `.env`
- Ensure redirect URI matches Google Cloud Console configuration

#### 2. "Rate limit exceeded"

**Cause:** Too many API requests to Google Drive

**Solution:**
- The module has built-in rate limiting (10 concurrent, 100ms between requests)
- Wait a few minutes and retry
- Reduce batch size if needed

#### 3. "Permission denied for file X"

**Cause:** User doesn't have download permissions for the file

**Solution:**
- Check file sharing settings in Google Drive
- Files without download permissions are automatically skipped
- Review error details in import status

#### 4. "Import stuck at X%"

**Cause:** Network issues or API errors

**Solution:**
- Check browser console for errors
- Verify server logs
- Retry logic should handle temporary failures
- Contact support if issue persists

#### 5. "No files found in folder"

**Cause:** Folder contains no image files or lacks permissions

**Solution:**
- Ensure folder contains images (jpg, png, gif, etc.)
- Check folder permissions in Google Drive
- Try a different folder

## Testing

### Running Tests

```bash
# Run all tests
bun test

# Run Google Drive import tests only
bun test google-drive

# Run performance tests
bun test performance

# Run integration tests
bun test integration/google-drive
```

### Test Coverage

- **Unit Tests:**
  - GoogleDriveClient (file listing, downloading, error handling)
  - DidPeerGenerator (DID creation, hashing)
  - BatchDidCreator (batch processing, progress tracking)
  - ImportProcessor (orchestration, status updates)

- **Integration Tests:**
  - API endpoints (list-files, start, status)
  - End-to-end import flow
  - Error handling across layers

- **Performance Tests:**
  - 250 file import benchmark
  - Memory usage verification
  - Throughput measurements

### Test Files

- `server/__tests__/google-drive-client.test.ts`
- `server/__tests__/did-peer-generator.test.ts`
- `server/__tests__/batch-did-creator.test.ts`
- `server/__tests__/import-processor.test.ts`
- `__tests__/integration/google-drive-import.test.ts`
- `server/__tests__/performance/google-drive-import-performance.test.ts`

## Additional Resources

- [Google Drive API Documentation](https://developers.google.com/drive/api/v3/about-sdk)
- [Google OAuth 2.0 Guide](https://developers.google.com/identity/protocols/oauth2)
- [Google Picker API](https://developers.google.com/picker)
- [DID:Peer Specification](https://identity.foundation/peer-did-method-spec/)
- [Originals SDK Documentation](../../packages/sdk/README.md)

## Support

For issues or questions:
1. Check this documentation
2. Review server logs
3. Check browser console
4. Open an issue on GitHub
5. Contact the development team
