# Task BE-02: Publish Asset to Web (did:webvh)

**Estimated Time**: 8-10 hours  
**Priority**: 🟠 Medium  
**Dependencies**: TASK_BE01 must be complete

---

## Objective

Implement the "Publish to Web" functionality that migrates an asset from `did:peer` (private) to `did:webvh` (public web layer), making it accessible via HTTPS with a publicly resolvable DID.

---

## Context Files to Read

```bash
# SDK lifecycle manager - publishToWeb method
src/lifecycle/LifecycleManager.ts

# OriginalsAsset structure
src/lifecycle/OriginalsAsset.ts

# DID:WebVH integration
apps/originals-explorer/server/did-webvh-service.ts
apps/originals-explorer/server/webvh-integration.ts

# Complete lifecycle test (shows publish flow)
tests/integration/CompleteLifecycle.e2e.test.ts

# Storage and schema
apps/originals-explorer/server/storage.ts
apps/originals-explorer/shared/schema.ts

# Current routes
apps/originals-explorer/server/routes.ts
```

---

## Background

The three-layer protocol works as follows:
1. **did:peer** (Private): Local-only, offline, no public access
2. **did:webvh** (Web): Published on HTTPS, publicly resolvable, verifiable history
3. **did:btco** (Bitcoin): Inscribed on Bitcoin, immutable, permanent

Publishing to web (`did:peer` → `did:webvh`) is the first migration step.

---

## Requirements

### 1. Create Backend Endpoint

**Endpoint**: `POST /api/assets/:id/publish-to-web`

**Input**:
```typescript
{
  domain?: string;  // Optional: custom domain for did:webvh
                    // Default: use app's configured domain
}
```

**Output**:
```typescript
{
  asset: {
    id: string;
    currentLayer: "did:webvh";
    didPeer: string;        // Original did:peer (preserved)
    didWebvh: string;       // NEW: did:webvh:domain.com:slug
    didDocument: object;    // Updated DID document
    credentials: object;    // Updated with webvh attestation
    provenance: {
      events: [
        { type: "created", layer: "did:peer", ... },
        { type: "published", layer: "did:webvh", ... }  // NEW
      ]
    };
    // ...
  };
  originalsAsset: {
    did: string;           // Now did:webvh
    previousDid: string;   // did:peer
    resources: [...];
    provenance: ProvenanceChain;
  };
}
```

### 2. Implementation Steps

#### Step 1: Validate Asset State

```typescript
// Get asset from database
const asset = await storage.getAsset(req.params.id);

if (!asset) {
  return res.status(404).json({ error: 'Asset not found' });
}

// Check ownership
if (asset.userId !== user.id) {
  return res.status(403).json({ error: 'Not authorized' });
}

// Check current layer
if (asset.currentLayer !== 'did:peer') {
  return res.status(400).json({ 
    error: `Asset is already in ${asset.currentLayer} layer. Can only publish from did:peer.`
  });
}

// Verify asset has did:peer identifier
if (!asset.didPeer) {
  return res.status(400).json({ 
    error: 'Asset missing did:peer identifier. Cannot publish.' 
  });
}
```

#### Step 2: Load OriginalsAsset from Storage

```typescript
import { OriginalsAsset } from '@originals/sdk';

// Reconstruct OriginalsAsset from database
const originalsAsset = new OriginalsAsset(
  asset.didPeer,
  asset.didDocument,
  JSON.parse(asset.metadata || '{}').resources || [],
  asset.provenance
);
```

#### Step 3: Call SDK to Publish

```typescript
import { originalsSdk } from './originals';

try {
  // Domain for did:webvh (use configured or custom)
  const domain = req.body.domain || process.env.WEBVH_DOMAIN || 'originals.example.com';
  
  // Publish to web - this creates did:webvh
  const publishedAsset = await originalsSdk.lifecycle.publishToWeb(
    originalsAsset,
    domain
  );
  
  console.log('Published to web:', publishedAsset.did);
  // publishedAsset.did is now "did:webvh:domain.com:slug"
  
} catch (error) {
  console.error('Publish error:', error);
  return res.status(500).json({ 
    error: 'Failed to publish to web',
    details: error.message 
  });
}
```

#### Step 4: Update Database

```typescript
// Update asset record with new layer and did:webvh
const updatedAsset = await storage.updateAsset(asset.id, {
  currentLayer: 'did:webvh',
  didWebvh: publishedAsset.did,
  didDocument: publishedAsset.didDocument,
  credentials: publishedAsset.credentials,
  provenance: publishedAsset.provenance,
  updatedAt: new Date()
});
```

#### Step 5: Publish DID Document to Web

```typescript
import { publishDIDDocument } from './did-webvh-service';

// Make DID document publicly accessible via HTTPS
await publishDIDDocument({
  did: publishedAsset.did,
  didDocument: publishedAsset.didDocument,
  didLog: publishedAsset.provenance // or separate log
});

// This should make the DID resolvable at:
// https://domain.com/.well-known/did/slug
```

#### Step 6: Return Response

```typescript
res.json({
  asset: updatedAsset,
  originalsAsset: {
    did: publishedAsset.did,
    previousDid: asset.didPeer,
    resources: publishedAsset.resources,
    provenance: publishedAsset.provenance
  },
  resolverUrl: `https://${domain}/.well-known/did/${extractSlug(publishedAsset.did)}`
});
```

### 3. DID:WebVH Publishing Service

Update or create `apps/originals-explorer/server/did-webvh-service.ts`:

```typescript
export async function publishDIDDocument(params: {
  did: string;
  didDocument: any;
  didLog?: any;
}): Promise<void> {
  const { did, didDocument, didLog } = params;
  
  // Extract slug from did:webvh:domain.com:slug
  const slug = did.split(':').pop();
  
  // Store in database or file system for public access
  await storage.storeDIDDocument(slug, {
    didDocument,
    didLog: didLog || { entries: [] },
    publishedAt: new Date().toISOString()
  });
  
  // If using S3 or CDN, upload there
  // await s3.upload({ ... });
  
  console.log(`DID document published: ${did}`);
}

export async function resolveDIDDocument(did: string): Promise<any> {
  const slug = did.split(':').pop();
  const doc = await storage.getDIDDocument(slug);
  
  if (!doc) {
    throw new Error('DID document not found');
  }
  
  return doc.didDocument;
}
```

### 4. DID Resolution Endpoint

Create: `GET /.well-known/did/:slug`

```typescript
app.get('/.well-known/did/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const did = `did:webvh:${req.hostname}:${slug}`;
    
    const didDocument = await resolveDIDDocument(did);
    
    res.json(didDocument);
  } catch (error) {
    res.status(404).json({ error: 'DID not found' });
  }
});
```

### 5. Error Handling

Handle these cases:
- Asset not found → 404
- Asset not owned by user → 403
- Asset already published (not in did:peer) → 400
- SDK publish fails → 500
- DID document publish fails → 500
- Invalid domain → 400

---

## Validation Checklist

Before marking complete:

- [ ] Endpoint creates valid `did:webvh` identifier
- [ ] Asset's `currentLayer` updates to "did:webvh"
- [ ] `didPeer` is preserved (not overwritten)
- [ ] `didWebvh` is stored correctly
- [ ] Provenance tracks "published" event
- [ ] Credentials updated with webvh attestation
- [ ] DID document is publicly accessible via HTTPS
- [ ] DID resolution endpoint works
- [ ] Can only publish from `did:peer` (validates current layer)
- [ ] Cannot publish twice (idempotent check)
- [ ] Error handling covers all edge cases
- [ ] Console logs show successful migration

---

## Testing

### Manual Test:

```bash
# 1. Create asset (should be in did:peer)
curl -X POST http://localhost:5000/api/assets/create-with-did \
  -H "Cookie: $AUTH_COOKIE" \
  -F "title=Test Publish" \
  -F "mediaFile=@image.png"

# Response includes: asset.id, asset.didPeer

# 2. Publish to web
ASSET_ID="orig_1234..."
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/publish-to-web \
  -H "Cookie: $AUTH_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{}'

# Expected response:
# - asset.currentLayer: "did:webvh"
# - asset.didWebvh: "did:webvh:domain.com:slug"
# - asset.provenance.events: [..., { type: "published", layer: "did:webvh" }]

# 3. Verify DID resolution
SLUG="extracted-from-didWebvh"
curl http://localhost:5000/.well-known/did/$SLUG

# Should return DID document JSON
```

### Database Verification:

```sql
SELECT id, title, current_layer, did_peer, did_webvh, 
       provenance->'events' as events
FROM assets 
WHERE current_layer = 'did:webvh' 
ORDER BY updated_at DESC 
LIMIT 1;
```

---

## Reference

See `tests/integration/CompleteLifecycle.e2e.test.ts` for a working example:

```typescript
// Create did:peer asset
const peerAsset = await originalsSdk.lifecycle.createAsset(resources);

// Publish to web → did:webvh
const webAsset = await originalsSdk.lifecycle.publishToWeb(
  peerAsset, 
  'example.com'
);

expect(webAsset.did).toMatch(/^did:webvh:/);
```

---

## Success Criteria

✅ Task is complete when:
1. Endpoint publishes assets from did:peer to did:webvh
2. DID documents are publicly accessible
3. DID resolution endpoint works
4. Provenance tracks migration event
5. Layer tracking updates correctly
6. Both DIDs preserved in database
7. Error handling is comprehensive
8. Manual testing confirms full flow
9. Cannot publish from wrong layer
10. Cannot publish same asset twice

---

## Next Task

After completion, proceed to:
- **TASK_FE02_PUBLISH_TO_WEB_UI.md** - Add publish button to UI
