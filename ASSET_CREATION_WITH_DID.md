# Asset Creation with DID Integration

This document describes the new `/api/assets/create-with-did` endpoint that integrates the Originals SDK for proper DID generation and provenance tracking.

## Overview

The endpoint creates assets with proper `did:peer` identifiers using the Originals SDK, ensuring verifiable credentials and complete provenance tracking from the moment of creation.

## Endpoint Details

**URL:** `POST /api/assets/create-with-did`

**Authentication:** Required (Bearer token)

**Content-Type:** 
- `multipart/form-data` (for file uploads)
- `application/json` (for URL-based media)

## Request Parameters

### Option 1: File Upload (multipart/form-data)

```bash
curl -X POST http://localhost:5000/api/assets/create-with-did \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "title=My Digital Art" \
  -F "description=Beautiful artwork" \
  -F "category=art" \
  -F "tags=[\"digital\", \"art\"]" \
  -F "metadata={\"artist\": \"John Doe\"}" \
  -F "mediaFile=@/path/to/image.png"
```

### Option 2: External URL (JSON)

```bash
curl -X POST http://localhost:5000/api/assets/create-with-did \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "My Digital Art",
    "description": "Beautiful artwork",
    "category": "art",
    "tags": ["digital", "art"],
    "mediaUrl": "https://example.com/image.png",
    "metadata": {
      "artist": "John Doe"
    }
  }'
```

## Request Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Asset title |
| `description` | string | No | Asset description |
| `category` | string | No | Asset category |
| `tags` | string[] | No | Array of tags |
| `mediaFile` | File | No* | Uploaded media file |
| `mediaUrl` | string | No* | External media URL |
| `metadata` | object | No | Additional metadata |

*Either `mediaFile` or `mediaUrl` must be provided.

## Supported File Types

- Images: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/svg+xml`
- Videos: `video/mp4`, `video/webm`
- Audio: `audio/mpeg`, `audio/wav`
- Documents: `application/pdf`

Maximum file size: 10MB

## Response Schema

```typescript
{
  asset: {
    id: string;                    // Database ID
    title: string;
    description: string | null;
    category: string | null;
    tags: string[] | null;
    mediaUrl: string | null;
    currentLayer: "did:peer";      // Current layer
    didPeer: string;               // DID identifier (e.g., "did:peer:abc123")
    didDocument: object;           // Complete DID document
    credentials: object;           // Verifiable credentials
    provenance: {                  // Provenance chain
      createdAt: string;
      creator: string;
      migrations: Array<object>;
      transfers: Array<object>;
    };
    status: string;
    assetType: string;
    createdAt: Date;
    metadata: object;
  };
  originalsAsset: {
    did: string;                   // DID identifier
    resources: Array<{             // Asset resources
      id: string;
      type: string;
      contentType: string;
      hash: string;
      content: string;
      url?: string;
    }>;
    provenance: {                  // Complete provenance chain
      createdAt: string;
      creator: string;
      migrations: Array<object>;
      transfers: Array<object>;
    };
  };
}
```

## Example Response

```json
{
  "asset": {
    "id": "orig_1735965432000_a1b2c3d4",
    "title": "My Digital Art",
    "description": "Beautiful artwork",
    "category": "art",
    "tags": ["digital", "art"],
    "mediaUrl": "https://example.com/image.png",
    "currentLayer": "did:peer",
    "didPeer": "did:peer:2Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc",
    "didDocument": {
      "id": "did:peer:2Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc",
      "@context": ["https://www.w3.org/ns/did/v1"],
      "verificationMethod": [/* ... */],
      "authentication": [/* ... */]
    },
    "credentials": [],
    "provenance": {
      "createdAt": "2025-10-06T12:00:00.000Z",
      "creator": "did:peer:2Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc",
      "migrations": [],
      "transfers": []
    },
    "status": "completed",
    "assetType": "original",
    "createdAt": "2025-10-06T12:00:00.000Z",
    "metadata": {
      "artist": "John Doe",
      "contentType": "image/png",
      "contentHash": "a3f1b2c...",
      "resourceId": "resource-1735965432000"
    }
  },
  "originalsAsset": {
    "did": "did:peer:2Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc",
    "resources": [
      {
        "id": "resource-1735965432000",
        "type": "image",
        "contentType": "application/json",
        "hash": "b4e2d3c1a5f...",
        "content": "{\"title\":\"My Digital Art\",\"description\":\"Beautiful artwork\",...}",
        "url": "https://example.com/image.png"
      }
    ],
    "provenance": {
      "createdAt": "2025-10-06T12:00:00.000Z",
      "creator": "did:peer:2Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc",
      "migrations": [],
      "transfers": []
    }
  }
}
```

## Error Responses

### 400 Bad Request

```json
{
  "error": "No media provided. Please provide either a mediaFile upload or mediaUrl."
}
```

```json
{
  "error": "Title is required and must be a non-empty string."
}
```

```json
{
  "error": "Failed to fetch media from URL",
  "details": "Network error message"
}
```

```json
{
  "error": "Invalid file type. Allowed types: images, videos, audio, PDF."
}
```

### 401 Unauthorized

```json
{
  "error": "Missing or invalid authorization header"
}
```

### 413 Payload Too Large

File exceeds 10MB limit.

### 500 Internal Server Error

```json
{
  "error": "Failed to create asset with Originals SDK",
  "details": "Detailed error message"
}
```

```json
{
  "error": "Failed to store asset in database",
  "details": "Detailed error message"
}
```

## Implementation Details

### Step 1: Hash Media Content

The endpoint hashes the media content (either from uploaded file or fetched URL) using SHA-256:

```typescript
const contentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
```

### Step 2: Create AssetResource Array

A metadata representation is created and hashed for DID generation:

```typescript
const assetMetadata = {
  title: title,
  description: description || '',
  category: category || '',
  tags: parsedTags,
  contentType: contentType,
  contentHash: contentHash,
  ...parsedMetadata
};

const metadataString = JSON.stringify(assetMetadata);
const metadataHash = crypto.createHash('sha256').update(metadataString).digest('hex');

const resources = [{
  id: `resource-${Date.now()}`,
  type: 'image', // or 'video', 'audio', 'file'
  contentType: 'application/json',
  hash: metadataHash,
  content: metadataString,
  url: mediaUrl
}];
```

### Step 3: Call SDK to Create Asset

```typescript
const originalsAsset = await originalsSdk.lifecycle.createAsset(resources);
```

### Step 4: Store in Database

The SDK-generated fields are stored alongside user-provided metadata:

```typescript
const asset = await storage.createAsset({
  userId: user.id,
  title: title,
  // ... user fields
  
  // SDK-generated fields
  currentLayer: 'did:peer',
  didPeer: originalsAsset.id,
  didDocument: originalsAsset.did,
  credentials: originalsAsset.credentials,
  provenance: originalsAsset.getProvenance(),
  
  status: 'completed',
  assetType: 'original'
});
```

### Step 5: Return Complete Response

Both the database record and the SDK asset are returned for complete transparency.

## Verification

To verify the endpoint is working correctly:

1. **Check DID Format:** The `didPeer` field should start with `did:peer:`
2. **Check Layer:** The `currentLayer` should be `"did:peer"`
3. **Check DID Document:** The `didDocument` should contain `id`, `@context`, and `verificationMethod`
4. **Check Provenance:** The `provenance` should have `createdAt`, `creator`, and empty `migrations`/`transfers` arrays
5. **Check Console Logs:** Server logs should show "✅ Created did:peer: ..." messages

## Database Verification

```sql
SELECT 
  id, 
  title, 
  current_layer, 
  did_peer, 
  did_document 
FROM assets 
WHERE current_layer = 'did:peer' 
ORDER BY created_at DESC 
LIMIT 1;
```

## Testing

Use the provided test script:

```bash
export AUTH_TOKEN="your-privy-jwt-token"
./test-create-asset-with-did.sh
```

## Comparison with Old Endpoint

### Old `/api/assets` (❌ No SDK)

```typescript
app.post("/api/assets", async (req, res) => {
  const asset = await storage.createAsset({
    title: req.body.title,
    // Just database fields, no DID generation
  });
});
```

### New `/api/assets/create-with-did` (✅ With SDK)

```typescript
app.post("/api/assets/create-with-did", authenticateUser, mediaUpload.single('mediaFile'), async (req, res) => {
  // 1. Hash content
  const contentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  
  // 2. Create resources
  const resources = [{ id, type, contentType, hash, content }];
  
  // 3. Use SDK to create did:peer
  const originalsAsset = await originalsSdk.lifecycle.createAsset(resources);
  
  // 4. Store with DID data
  const asset = await storage.createAsset({
    ...userData,
    currentLayer: 'did:peer',
    didPeer: originalsAsset.id,
    didDocument: originalsAsset.did,
    credentials: originalsAsset.credentials,
    provenance: originalsAsset.getProvenance()
  });
  
  // 5. Return both records
  res.json({ asset, originalsAsset });
});
```

## Success Criteria

✅ Task is complete when:

- [x] Endpoint creates assets with proper `did:peer` identifiers
- [x] DID documents and credentials are stored in database
- [x] Provenance tracking works from creation
- [x] Both file upload and URL options work
- [x] Error handling covers all edge cases
- [x] Manual testing confirms SDK integration
- [x] Database shows proper layer tracking
- [x] Console logs show SDK calls are working

## Next Steps

After assets are created with `did:peer`, they can be migrated to:

1. **did:webvh** - Publish to web using `/api/assets/:id/publish-to-web`
2. **did:btco** - Inscribe on Bitcoin using `/api/assets/:id/inscribe-on-bitcoin`

Each migration maintains the complete provenance chain.
