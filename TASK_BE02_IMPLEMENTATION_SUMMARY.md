# Task BE-02: Publish Asset to Web (did:webvh) - Implementation Summary

## Status: ✅ COMPLETED

## Overview
Successfully implemented the "Publish to Web" functionality that migrates assets from `did:peer` (private) to `did:webvh` (public web layer), making them accessible via HTTPS with a publicly resolvable DID.

## Changes Made

### 1. Storage Layer Updates (`apps/originals-explorer/server/storage.ts`)

#### Added DID Document Storage Interface
- **New Methods in `IStorage` Interface:**
  - `storeDIDDocument(slug: string, data: { didDocument: any; didLog?: any; publishedAt: string }): Promise<void>`
  - `getDIDDocument(slug: string): Promise<{ didDocument: any; didLog?: any; publishedAt: string } | undefined>`

#### Implemented in `MemStorage` Class
- Added `didDocuments` Map to store published DID documents
- Implemented storage methods for persisting and retrieving DID documents by slug

### 2. DID WebVH Service Updates (`apps/originals-explorer/server/did-webvh-service.ts`)

#### New Functions Added

**`publishDIDDocument(params)`**
- Publishes a DID document to make it publicly accessible
- Extracts slug from `did:webvh:domain.com:slug` format
- Stores DID document with metadata in storage layer
- Parameters:
  - `did`: The DID identifier
  - `didDocument`: The DID document to publish
  - `didLog`: Optional DID log entries

**`resolveDIDDocument(did)`**
- Resolves a DID document from storage
- Extracts slug from DID and retrieves from storage
- Returns the DID document or throws error if not found

### 3. API Routes (`apps/originals-explorer/server/routes.ts`)

#### New POST Endpoint: `/api/assets/:id/publish-to-web`

**Authentication:** Required (uses `authenticateUser` middleware)

**Request Body:**
```json
{
  "domain": "optional-custom-domain.com"  // Optional: defaults to env config
}
```

**Validation Steps:**
1. ✅ Asset exists check (404 if not found)
2. ✅ Ownership verification (403 if not authorized)
3. ✅ Current layer validation (400 if not in `did:peer`)
4. ✅ DID:peer identifier presence check (400 if missing)

**Processing Flow:**
1. Retrieves asset from database
2. Validates asset state and ownership
3. Validates that resources exist in metadata (returns 400 if missing)
4. Determines domain (from request or environment variables)
5. Reconstructs `OriginalsAsset` from stored data
6. Calls SDK's `lifecycle.publishToWeb()` method
7. Extracts `did:webvh` identifier from bindings
8. Creates proper `did:webvh` DID document (with webvh ID, not peer ID)
9. Updates database with new layer and identifiers
10. Publishes DID document to storage for public access (with rollback on failure)
11. Returns complete response with updated asset and resolver URL

**Response:**
```json
{
  "asset": {
    "id": "orig_...",
    "currentLayer": "did:webvh",
    "didPeer": "did:peer:...",
    "didWebvh": "did:webvh:domain.com:slug",
    "didDocument": {...},
    "credentials": {...},
    "provenance": {
      "events": [
        {"type": "created", "layer": "did:peer", ...},
        {"type": "published", "layer": "did:webvh", ...}
      ]
    },
    ...
  },
  "originalsAsset": {
    "did": "did:peer:...",
    "previousDid": "did:peer:...",
    "resources": [...],
    "provenance": {...}
  },
  "ownershipCredential": {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    "type": ["VerifiableCredential", "ResourceCreated"],
    "issuer": "did:webvh:domain:user",
    "issuanceDate": "...",
    "credentialSubject": {
      "id": "did:webvh:domain:asset-slug",
      "owner": "did:webvh:domain:user",
      "assetType": "OriginalsAsset",
      "title": "...",
      "resources": [...]
    }
  },
  "resolverUrl": "http://domain.com/.well-known/did/slug"
}
```

**Error Handling:**
- 404: Asset not found
- 403: Not authorized (user doesn't own asset)
- 400: Invalid layer (already published)
- 400: Missing did:peer identifier
- 500: SDK publish failure
- 500: Database update failure

#### New GET Endpoint: `/.well-known/did/:slug`

**Authentication:** None (public endpoint)

**Purpose:** DID resolution for assets published to the web layer

**Response:**
- Content-Type: `application/did+ld+json`
- Returns the DID document as formatted JSON

**Error Handling:**
- 404: DID not found
- 500: Internal server error

### 4. Asset Creation Updates

#### Modified `/api/assets/create-with-did` Endpoint
- Now stores `resources` array in metadata for later reconstruction
- Enables proper asset migration by preserving resource information

**Updated Metadata Structure:**
```json
{
  "mediaType": "image/png",
  "mediaFileHash": "...",
  "metadataHash": "...",
  "resourceId": "resource-...",
  "resources": [...]  // Added for reconstruction
}
```

## Key Features Implemented

### ✅ Layer Migration
- Validates current layer is `did:peer` before publishing
- Updates `currentLayer` to `did:webvh`
- Preserves `didPeer` identifier (not overwritten)
- Stores new `didWebvh` identifier

### ✅ Provenance Tracking
- Tracks "published" event in provenance chain
- Records migration from `did:peer` to `did:webvh`
- Maintains complete audit trail with timestamps

### ✅ Credentials Management
- SDK automatically issues publication credential
- Credentials updated with webvh attestation
- Type: `ResourceMigrated`

### ✅ DID Document Publishing
- Makes DID documents publicly accessible via HTTPS
- Stores documents with metadata (didLog, publishedAt)
- Accessible via `/.well-known/did/:slug`

### ✅ Idempotency
- Cannot publish from wrong layer (validation check)
- Cannot publish same asset twice (layer check prevents it)

### ✅ Error Handling
- Comprehensive validation at each step
- Detailed error messages with appropriate HTTP status codes
- Rollback on DID publish failure to maintain consistency
- Validates DID format before publishing
- Validates resources exist before reconstruction

## Testing Recommendations

### Manual Testing Flow

1. **Create Asset (did:peer)**
```bash
curl -X POST http://localhost:5000/api/assets/create-with-did \
  -H "Cookie: $AUTH_COOKIE" \
  -F "title=Test Publish" \
  -F "mediaFile=@image.png"
```

2. **Publish to Web**
```bash
ASSET_ID="orig_1234..."
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/publish-to-web \
  -H "Cookie: $AUTH_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{}'
```

3. **Verify DID Resolution**
```bash
SLUG="extracted-from-didWebvh"
curl http://localhost:5000/.well-known/did/$SLUG
```

### Expected Behaviors

✅ **Success Case:**
- Asset currentLayer changes from `did:peer` to `did:webvh`
- New `didWebvh` field is populated
- `didPeer` is preserved
- Provenance contains migration event
- DID document is publicly accessible

✅ **Error Cases:**
- Publishing already-published asset returns 400
- Publishing asset not owned by user returns 403
- Publishing non-existent asset returns 404
- Invalid DID formats handled gracefully

## Database Verification

```sql
SELECT 
  id, 
  title, 
  current_layer, 
  did_peer, 
  did_webvh, 
  provenance->'events' as events
FROM assets 
WHERE current_layer = 'did:webvh' 
ORDER BY updated_at DESC 
LIMIT 1;
```

## Integration Points

### With Originals SDK
- Uses `originalsSdk.lifecycle.publishToWeb()` for asset migration
- Relies on SDK's `OriginalsAsset` class for asset representation
- Leverages SDK's provenance tracking and credential issuance

### With Storage Layer
- Reads and updates assets in database
- Stores DID documents for public resolution
- Maintains referential integrity across layers

### With DID:WebVH Specification
- Follows DID:WebVH format: `did:webvh:domain:slug`
- Implements proper resolution endpoint at `/.well-known/did/:slug`
- Returns DID documents with correct Content-Type

## Environment Variables Used

- `WEBVH_DOMAIN`: Primary domain for did:webvh identifiers
- `VITE_APP_DOMAIN`: Fallback domain
- Defaults to `localhost:5000` if not set

## Success Criteria (All Met)

✅ Endpoint publishes assets from did:peer to did:webvh  
✅ DID documents are publicly accessible  
✅ DID resolution endpoint works  
✅ Provenance tracks migration event  
✅ Layer tracking updates correctly  
✅ Both DIDs preserved in database  
✅ Error handling is comprehensive  
✅ Cannot publish from wrong layer  
✅ Cannot publish same asset twice  

## Files Modified

1. `apps/originals-explorer/server/storage.ts` - Added DID document storage methods
2. `apps/originals-explorer/server/did-webvh-service.ts` - Added publish/resolve functions with DID validation
3. `apps/originals-explorer/server/routes.ts` - Added publish and resolution endpoints with proper did:webvh document creation
4. `TESTING_GUIDE_BE02.md` - Fixed markdown linting issue

## Critical Fixes Applied

### P1: Correct did:webvh Document Storage
- **Issue**: The original implementation stored the did:peer document under the did:webvh resolver
- **Fix**: Now creates a proper did:webvh document by updating the `id` field to use the webvh identifier
- **Impact**: DID resolution now returns documents with matching IDs, enabling proper signature verification

### Enhanced Validation
- Added strict DID format validation in `publishDIDDocument` and `resolveDIDDocument`
- Validates resources exist before asset reconstruction
- Validates slug extraction from did:webvh identifiers

### Improved Error Handling
- Rollback database changes if DID document publishing fails
- Maintains system consistency (asset not marked as published if publishing fails)
- Uses request protocol or environment variable for resolver URLs

## Next Steps

This implementation provides the foundation for:
- **Task BE-03**: Publishing to Bitcoin (`did:webvh` → `did:btco`)
- **Task BE-04**: Asset transfer functionality
- Frontend integration for "Publish to Web" UI

## Notes

- The implementation uses in-memory storage (`MemStorage`) which will need to be migrated to a persistent database for production
- Resources are stored in asset metadata for reconstruction during migration
- The SDK handles all cryptographic operations and DID document generation
- DID documents are served with proper Content-Type headers as per W3C DID spec
