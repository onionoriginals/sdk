# PublishToWeb API Changes - DID-Based Resource Paths

## Summary of Changes

The `publishToWeb` method has been updated to use DID-based resource paths instead of `.well-known` paths, and now requires a publisher DID or signer object instead of a domain parameter.

## Key Changes

### 1. Method Signature Change

**Before:**
```typescript
async publishToWeb(
  asset: OriginalsAsset,
  domain: string
): Promise<OriginalsAsset>
```

**After:**
```typescript
async publishToWeb(
  asset: OriginalsAsset,
  publisherDidOrSigner: string | ExternalSigner
): Promise<OriginalsAsset>
```

### 2. Resource URL Format Change

**Before:**
```
https://{domain}/.well-known/webvh/{slug}/resources/{hash}
```

**After:**
```
https://{domain}/{userPath}/resources/{hash}
```

Where `{userPath}` is extracted from the publisher's DID:webvh.

### 3. Publisher DID Requirement

The method now requires:
- **Option 1**: A `did:webvh` identifier string (e.g., `did:webvh:example.com:alice`)
- **Option 2**: An `ExternalSigner` object with a verification method associated with a `did:webvh`

### 4. Credential Signing

The method now supports two signing modes:
1. **External Signer**: Uses the provided `ExternalSigner` to sign the publication credential
2. **KeyStore**: Falls back to the existing keyStore-based signing if only a DID string is provided

## Implementation Details

### Resource URL Generation

The new implementation:

```typescript
// Extract user path from publisher DID
// Format: did:webvh:domain:user or did:webvh:domain:path1:path2
const didParts = publisherDid.split(':');
const userPathSegments = didParts.slice(3); // Skip 'did', 'webvh', 'domain'
const userPath = userPathSegments.join('/');

// Generate resource URL (NO .well-known)
const relativePath = `${userPath}/resources/${multibase}`;
```

### Example

For publisher DID: `did:webvh:example.com:alice`

Resource URLs will be:
```
https://example.com/alice/resources/uEiAbc123...
https://example.com/alice/resources/uEiDef456...
```

For publisher DID: `did:webvh:example.com:projects:my-app`

Resource URLs will be:
```
https://example.com/projects/my-app/resources/uEiAbc123...
https://example.com/projects/my-app/resources/uEiDef456...
```

## Migration Guide

### Before (Old API)

```typescript
const asset = await sdk.lifecycle.createAsset(resources);
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
```

### After (New API)

**Option 1: Using a DID string**
```typescript
const asset = await sdk.lifecycle.createAsset(resources);
const publisherDid = 'did:webvh:example.com:alice';
const published = await sdk.lifecycle.publishToWeb(asset, publisherDid);
```

**Option 2: Using a signer object**
```typescript
const asset = await sdk.lifecycle.createAsset(resources);
const signer = createMyExternalSigner(); // e.g., Privy signer
const published = await sdk.lifecycle.publishToWeb(asset, signer);
```

## Files Modified

### Core Implementation
1. **src/lifecycle/LifecycleManager.ts**
   - `publishToWeb()` method signature and implementation
   - Resource URL path generation logic
   - Credential signing with external signer support

2. **src/vc/CredentialManager.ts**
   - Added `signCredentialWithExternalSigner()` method
   - Added `ExternalSigner` import

### Type Definitions
- **src/types/common.ts**: `ExternalSigner` interface (already existed)

## Breaking Changes

⚠️ **BREAKING CHANGE**: The `publishToWeb` method signature has changed.

### Migration Required

All code that calls `publishToWeb(asset, domain)` must be updated to:
1. Create or obtain a `did:webvh` for the publisher
2. Pass the DID or signer instead of domain

### Affected Tests

The following test files need to be updated:
- `tests/integration/WebVhPublish.test.ts`
- `tests/integration/DidPeerToWebVhFlow.test.ts`
- `apps/originals-explorer/server/__tests__/publish-to-web.test.ts`
- `apps/originals-explorer/__tests__/integration/publish-flow.test.ts`

### Affected Server Routes

- `apps/originals-explorer/server/routes.ts`: The `/api/assets/:id/publish-to-web` endpoint needs updating

## Batch Operations

⚠️ **TODO**: The `batchPublishToWeb` method also needs to be updated to accept `publisherDidOrSigner` instead of `domain`.

Current signature:
```typescript
async batchPublishToWeb(
  assets: OriginalsAsset[],
  domain: string,
  options?: BatchOperationOptions
): Promise<BatchResult<OriginalsAsset>>
```

Should become:
```typescript
async batchPublishToWeb(
  assets: OriginalsAsset[],
  publisherDidOrSigner: string | ExternalSigner,
  options?: BatchOperationOptions
): Promise<BatchResult<OriginalsAsset>>
```

## Benefits of New Approach

1. **No .well-known dependency**: Resource paths are derived directly from DID structure
2. **Publisher attribution**: Resources are explicitly associated with the publisher's DID
3. **Flexible signing**: Supports both internal key management and external signers
4. **Better security**: Publishers must have a valid did:webvh to publish resources
5. **Cleaner URLs**: `/alice/resources/xyz` instead of `/.well-known/webvh/slug/resources/xyz`

## Credential Structure Changes

The publication credential now uses:
- **Issuer**: The publisher's did:webvh (not the asset's did:peer)
- **Subject**: The asset being published
- **Additional field**: `publishedAs` contains the webvh binding

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "ResourceMigrated"],
  "issuer": "did:webvh:example.com:alice",
  "credentialSubject": {
    "id": "did:peer:2z...",
    "publishedAs": "did:webvh:example.com:alice",
    "resourceId": "r1",
    "fromLayer": "did:peer",
    "toLayer": "did:webvh",
    "migratedAt": "2025-10-07T..."
  },
  "proof": {...}
}
```

## Testing Recommendations

### Unit Tests
- Test with valid did:webvh strings
- Test with ExternalSigner objects
- Test validation errors (non-webvh DIDs, invalid signers)
- Test resource URL generation for various DID paths

### Integration Tests
- Test end-to-end publish flow with DID
- Test with external signer integration (e.g., Privy)
- Verify resource URLs are correctly formatted
- Verify credentials are properly signed by publisher

### Server Tests
- Update HTTP API tests to pass publisher DID
- Test user's own did:webvh is used for publishing
- Test authorization (users can only publish with their own DID)

## Next Steps

1. ✅ Update `publishToWeb` signature and implementation
2. ✅ Add `signCredentialWithExternalSigner` method
3. ✅ Update resource URL generation logic
4. ⏳ Update `batchPublishToWeb` method
5. ⏳ Update all test files
6. ⏳ Update server routes
7. ⏳ Update documentation
8. ⏳ Update example code

## Example Server Integration

```typescript
app.post("/api/assets/:id/publish-to-web", authenticateUser, async (req, res) => {
  const user = (req as any).user;
  const asset = await storage.getAsset(req.params.id);
  
  // Use the user's did:webvh for publishing
  const publisherDid = user.didWebvh; // e.g., "did:webvh:example.com:alice"
  
  // Reconstruct OriginalsAsset
  const originalsAsset = new OriginalsAsset(
    asset.metadata.resources,
    asset.didDocument,
    asset.credentials
  );
  
  // Publish using the publisher's DID
  const published = await sdk.lifecycle.publishToWeb(originalsAsset, publisherDid);
  
  // Resources now have URLs like: /alice/resources/uEi...
  res.json({ asset: published });
});
```

## Summary

These changes align the implementation with the requirements:
- ✅ No `.well-known` path usage
- ✅ Path derived from publisher's DID
- ✅ No domain parameter at this layer
- ✅ Requires DID or signer object
- ✅ Resource URLs use DID-based paths
- ✅ Publisher can sign credentials with external signer