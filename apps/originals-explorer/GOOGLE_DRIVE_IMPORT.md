# Google Drive Import Feature

This feature allows you to import files from Google Drive folders and automatically create did:peer assets for each file.

## Features

- **Browse Google Drive folders**: List all files in a specific Google Drive folder
- **Selective import**: Choose which files to import or import all files at once
- **Automatic did:peer creation**: Each imported file automatically gets a did:peer identifier
- **Smart file handling**: 
  - Files under 10MB are downloaded and stored
  - Larger files or Google Docs are stored as references
  - Maintains metadata including thumbnails and links

## Setup

### 1. Install Dependencies

The Google Drive API client is already included in the dependencies:

```bash
npm install googleapis
```

### 2. Configure Google OAuth

You need to set up Google OAuth credentials:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google Drive API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URIs (e.g., `http://localhost:5000/api/auth/google/callback`)

### 3. Set Environment Variables

Add these to your `.env` file:

```env
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
GOOGLE_REDIRECT_URI=http://localhost:5000/api/auth/google/callback
```

## Usage

### Frontend (User Interface)

1. Navigate to `/import-google-drive` in the app
2. Enter your Google access token (or connect via OAuth)
3. Optionally enter a folder ID (leave empty for root folder)
4. Click "List Files" to see all files in the folder
5. Select files to import (or import all)
6. Choose a category (art, music, video, document, etc.)
7. Click "Import" to create did:peer assets

### Backend API Endpoints

#### List Files in a Folder

```http
POST /api/google-drive/list-folder
Authorization: Bearer <privy_token>
Content-Type: application/json

{
  "accessToken": "google_access_token",
  "folderId": "optional_folder_id"
}
```

**Response:**
```json
{
  "success": true,
  "folderId": "root",
  "count": 5,
  "files": [
    {
      "id": "file_id",
      "name": "document.pdf",
      "mimeType": "application/pdf",
      "size": "1234567",
      "webViewLink": "https://drive.google.com/...",
      "thumbnailLink": "https://..."
    }
  ]
}
```

#### Import Folder

```http
POST /api/google-drive/import-folder
Authorization: Bearer <privy_token>
Content-Type: application/json

{
  "accessToken": "google_access_token",
  "folderId": "optional_folder_id",
  "fileIds": ["file1", "file2"], // optional - specific files
  "category": "document" // optional - default category
}
```

**Response:**
```json
{
  "success": true,
  "imported": 3,
  "failed": 0,
  "total": 3,
  "assets": [
    {
      "id": "orig_123",
      "title": "document.pdf",
      "didPeer": "did:peer:...",
      "currentLayer": "did:peer",
      ...
    }
  ]
}
```

## How It Works

### Import Process

1. **Authentication**: User provides Google access token
2. **List Files**: Backend queries Google Drive API for files
3. **Download/Reference**: 
   - Small files (<10MB) are downloaded and stored
   - Large files or Google Docs are stored as references
4. **Create did:peer**: Each file gets a unique did:peer identifier using the Originals SDK
5. **Store in Database**: Assets are saved with full metadata and provenance

### Asset Structure

Each imported file creates an asset with:

```typescript
{
  title: "filename",
  description: "Imported from Google Drive",
  category: "document",
  tags: ["google-drive", "imported"],
  currentLayer: "did:peer",
  didPeer: "did:peer:...",
  didDocument: { /* DID document */ },
  credentials: [ /* verifiable credentials */ ],
  provenance: { /* provenance chain */ },
  metadata: {
    mediaType: "application/pdf",
    mediaFileHash: "sha256_hash",
    googleDrive: {
      fileId: "drive_file_id",
      webViewLink: "https://...",
      thumbnailLink: "https://..."
    }
  }
}
```

## Security Considerations

- Access tokens are never stored on the server
- Users must provide their own Google OAuth tokens
- File size limits prevent DoS attacks (10MB max)
- Only authenticated users can import files
- All imported assets are owned by the importing user

## Troubleshooting

### "Failed to list files"

- Check that your access token is valid
- Ensure the Google Drive API is enabled
- Verify the folder ID is correct

### "Failed to import files"

- Check file permissions in Google Drive
- Verify you have read access to the files
- Check server logs for specific error details

### "Token expired"

- Google access tokens typically expire after 1 hour
- Re-authenticate to get a new token
- Consider implementing refresh token flow

## Future Enhancements

- [ ] OAuth flow integration in the UI
- [ ] Batch import with progress tracking
- [ ] Folder structure preservation
- [ ] Automatic token refresh
- [ ] Support for shared drives
- [ ] File preview before import
- [ ] Duplicate detection
