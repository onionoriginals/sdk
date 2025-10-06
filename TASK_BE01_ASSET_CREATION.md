# Task BE-01: Asset Creation with DID Integration

**Estimated Time**: 6-8 hours  
**Priority**: 🔴 Critical  
**Dependencies**: Database schema migration complete

---

## Objective

Integrate the Originals SDK into the asset creation flow so that when a user creates an asset, it generates a proper `did:peer` identifier with verifiable credentials and provenance tracking.

---

## Context Files to Read

Read these files **first** to understand the current implementation:

```bash
# Current asset creation endpoint (does NOT use SDK)
apps/originals-explorer/server/routes.ts (lines 200-240)

# Working SDK example (DOES use SDK correctly)
apps/originals-explorer/server/routes.ts (lines 420-550, /api/assets/upload-spreadsheet)

# SDK lifecycle manager
src/lifecycle/LifecycleManager.ts

# Originals asset structure
src/lifecycle/OriginalsAsset.ts

# Database schema
apps/originals-explorer/shared/schema.ts

# Storage interface
apps/originals-explorer/server/storage.ts

# SDK configuration
apps/originals-explorer/server/originals.ts

# End-to-end test showing complete lifecycle
tests/integration/CompleteLifecycle.e2e.test.ts
```

---

## Current Problem

The existing `POST /api/assets` endpoint at line ~200 in `routes.ts` creates database records but does NOT use the SDK:

```typescript
// ❌ CURRENT: No SDK, no DID generation
app.post("/api/assets", authenticateUser, async (req, res) => {
  const asset = await storage.createAsset({
    title: req.body.title,
    // ... just database fields
  });
});
```

The `POST /api/assets/upload-spreadsheet` endpoint at line ~420 DOES use the SDK correctly:

```typescript
// ✅ CORRECT: Uses SDK to create did:peer
const originalsAsset = await originalsSdk.lifecycle.createAsset(resources);
// Stores DID, credentials, provenance in database
```

---

## Requirements

### 1. Create New Endpoint

Create: `POST /api/assets/create-with-did`

**Input Schema**:
```typescript
{
  title: string;
  description?: string;
  category?: string;
  tags?: string[];
  mediaFile?: File;           // Optional uploaded file
  mediaUrl?: string;           // OR external URL
  metadata?: Record<string, any>;
}
```

**Output Schema**:
```typescript
{
  asset: {
    id: string;
    title: string;
    currentLayer: "did:peer";
    didPeer: string;           // e.g., "did:peer:abc123"
    didDocument: object;       // Complete DID document
    credentials: object;       // Verifiable credentials
    provenance: {
      events: Array<{
        type: string;
        timestamp: string;
        actor: string;
      }>;
    };
    // ... other fields
  };
  originalsAsset: {
    did: string;
    resources: Array<...>;
    provenance: ProvenanceChain;
  };
}
```

### 2. Implementation Steps

#### Step 1: Hash Media Content
```typescript
import { createHash } from 'crypto';

// If file uploaded
const fileBuffer = await req.file.buffer;
const contentHash = createHash('sha256').update(fileBuffer).digest('hex');

// If URL provided, fetch first
const response = await fetch(mediaUrl);
const buffer = Buffer.from(await response.arrayBuffer());
const contentHash = createHash('sha256').update(buffer).digest('hex');
```

#### Step 2: Create AssetResource Array
```typescript
const resources: AssetResource[] = [
  {
    id: `resource-${Date.now()}`,
    type: 'image',
    uri: mediaUrl || `data:image/png;base64,${fileBuffer.toString('base64')}`,
    contentHash,
    metadata: {
      title: req.body.title,
      description: req.body.description,
      category: req.body.category,
      tags: req.body.tags || [],
      ...req.body.metadata
    }
  }
];
```

#### Step 3: Call SDK to Create Asset
```typescript
import { originalsSdk } from './originals';

const originalsAsset = await originalsSdk.lifecycle.createAsset(resources);
```

#### Step 4: Store in Database
```typescript
const asset = await storage.createAsset({
  userId: user.id,
  title: req.body.title,
  description: req.body.description,
  category: req.body.category,
  tags: req.body.tags,
  mediaUrl: mediaUrl || null,
  metadata: req.body.metadata || {},
  
  // SDK-generated fields
  currentLayer: 'did:peer',
  didPeer: originalsAsset.did,
  didDocument: originalsAsset.didDocument,
  credentials: originalsAsset.credentials,
  provenance: originalsAsset.provenance,
  
  status: 'completed',
  assetType: 'original'
});
```

#### Step 5: Return Complete Response
```typescript
res.json({
  asset,
  originalsAsset: {
    did: originalsAsset.did,
    resources: originalsAsset.resources,
    provenance: originalsAsset.provenance
  }
});
```

### 3. Error Handling

Handle these error cases:
- No media file or URL provided → 400 Bad Request
- SDK creation fails → 500 Internal Server Error (with details)
- Database storage fails → 500 (rollback if needed)
- Invalid file type → 400 Bad Request
- File too large → 413 Payload Too Large

### 4. File Upload Configuration

If using multer for file uploads:
```typescript
import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

app.post('/api/assets/create-with-did', authenticateUser, upload.single('mediaFile'), async (req, res) => {
  // ...
});
```

---

## Validation Checklist

Before marking complete, verify:

- [ ] Endpoint creates a valid `did:peer` identifier
- [ ] DID document is stored in database
- [ ] Verifiable credentials are generated and stored
- [ ] Provenance chain tracks asset creation
- [ ] `currentLayer` is set to "did:peer"
- [ ] `didPeer` field contains the DID identifier
- [ ] Response includes both database record and SDK asset
- [ ] Error handling covers all edge cases
- [ ] File uploads work (if implemented)
- [ ] External URL fetching works (if implemented)
- [ ] No sensitive data in error messages
- [ ] Console logs show SDK calls are working

---

## Testing

### Manual Test:
```bash
# Create asset with file upload
curl -X POST http://localhost:5000/api/assets/create-with-did \
  -H "Cookie: your-auth-cookie" \
  -F "title=My Digital Art" \
  -F "description=Beautiful artwork" \
  -F "category=art" \
  -F "mediaFile=@/path/to/image.png"

# Expected response should include:
# - asset.didPeer: "did:peer:..."
# - asset.currentLayer: "did:peer"
# - asset.didDocument: { ... }
# - asset.credentials: { ... }
# - asset.provenance: { events: [...] }
```

### Verify in Database:
```sql
SELECT id, title, current_layer, did_peer, did_document 
FROM assets 
WHERE current_layer = 'did:peer' 
ORDER BY created_at DESC 
LIMIT 1;
```

---

## Reference Implementation

See `POST /api/assets/upload-spreadsheet` at line ~420 in `routes.ts` for a working example that uses the SDK correctly for bulk asset creation.

Key differences:
- Bulk endpoint processes CSV rows
- This endpoint processes a single asset
- Both should use `originalsSdk.lifecycle.createAsset()`

---

## Success Criteria

✅ Task is complete when:
1. Endpoint creates assets with proper `did:peer` identifiers
2. DID documents and credentials are stored
3. Provenance tracking works
4. Both file upload and URL options work
5. Error handling is robust
6. Manual testing confirms SDK integration
7. Database shows proper layer tracking

---

## Next Task

After completion, proceed to:
- **TASK_FE01_ASSET_CREATION_UI.md** - Update frontend to use new endpoint
