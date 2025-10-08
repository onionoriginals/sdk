# Summary: DID Peer to WebVH Publication Changes

## Changes Completed ✅

### 1. Updated `publishToWeb` Method Signature

**File**: `src/lifecycle/LifecycleManager.ts` (Lines 222-441)

**Changed from:**
```typescript
async publishToWeb(asset: OriginalsAsset, domain: string)
```

**Changed to:**
```typescript
async publishToWeb(asset: OriginalsAsset, publisherDidOrSigner: string | ExternalSigner)
```

### 2. Removed `.well-known` Path Structure

**Before:**
```typescript
const relativePath = `.well-known/webvh/${slug}/resources/${multibase}`;
```

**After:**
```typescript
// Extract user path from publisher's DID
const didParts = publisherDid.split(':');
const userPathSegments = didParts.slice(3); // Skip 'did', 'webvh', 'domain'
const userPath = userPathSegments.join('/');
const relativePath = `${userPath}/resources/${multibase}`;
```

### 3. DID-Based Resource URLs

Resources now have URLs based on the publisher's DID path:

- **Publisher DID**: `did:webvh:example.com:alice`
- **Resource URL**: `https://example.com/alice/resources/uEiAbc123...`

- **Publisher DID**: `did:webvh:example.com:projects:app1`
- **Resource URL**: `https://example.com/projects/app1/resources/uEiDef456...`

### 4. Added External Signer Support

**File**: `src/vc/CredentialManager.ts` (Lines 82-115)

Added `signCredentialWithExternalSigner()` method to support signing credentials with external signers (e.g., Privy, hardware wallets).

### 5. Updated Credential Issuance

Publication credentials are now:
- **Issued by**: Publisher's did:webvh (not the asset's did:peer)
- **Subject**: The asset being published
- **Signed with**: Either external signer or keyStore-based private key

## Changes Required ⏳

### 1. Update `batchPublishToWeb` Method

**File**: `src/lifecycle/LifecycleManager.ts` (Line 658)

Needs to be updated to accept `publisherDidOrSigner` instead of `domain`:

```typescript
async batchPublishToWeb(
  assets: OriginalsAsset[],
  publisherDidOrSigner: string | ExternalSigner,  // ⚠️ Change needed
  options?: BatchOperationOptions
)
```

### 2. Update Tests

The following test files need updates:

- `tests/integration/WebVhPublish.test.ts`
  - Change: `publishToWeb(asset, domain)` → `publishToWeb(asset, publisherDid)`
  
- `tests/integration/DidPeerToWebVhFlow.test.ts`
  - Update to pass did:webvh instead of domain
  - Update URL assertions (no `.well-known` expected)
  
- `apps/originals-explorer/server/__tests__/publish-to-web.test.ts`
  - Update server integration tests
  - Update URL format expectations

### 3. Update Server Routes

**File**: `apps/originals-explorer/server/routes.ts` (Line ~671)

```typescript
// OLD
const domain = req.body.domain || process.env.WEBVH_DOMAIN || 'localhost:5000';
const published = await sdk.lifecycle.publishToWeb(originalsAsset, domain);

// NEW
const publisherDid = user.didWebvh; // User's did:webvh
const published = await sdk.lifecycle.publishToWeb(originalsAsset, publisherDid);
```

### 4. Update Documentation

Update the following docs:
- `DID_PEER_TO_WEBVH_FLOW_VERIFICATION.md`
- `VERIFICATION_SUMMARY.md`
- Example code in README files

## Usage Examples

### Before (Old API)

```typescript
const asset = await sdk.lifecycle.createAsset(resources);
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
console.log(published.resources[0].url);
// https://example.com/.well-known/webvh/abc123/resources/uEi...
```

### After (New API)

```typescript
const asset = await sdk.lifecycle.createAsset(resources);
const publisherDid = 'did:webvh:example.com:alice';
const published = await sdk.lifecycle.publishToWeb(asset, publisherDid);
console.log(published.resources[0].url);
// https://example.com/alice/resources/uEi...
```

### With External Signer

```typescript
const asset = await sdk.lifecycle.createAsset(resources);
const signer = await createPrivySigner(userId, walletId, privyClient);
const published = await sdk.lifecycle.publishToWeb(asset, signer);
// Credential is signed by the external signer
```

## Key Benefits

1. ✅ **No `.well-known` dependency** - Paths derived from DID structure
2. ✅ **Publisher attribution** - Resources explicitly tied to publisher DID
3. ✅ **Flexible signing** - Supports external signers (Privy, wallets, etc.)
4. ✅ **Better security** - Requires valid did:webvh to publish
5. ✅ **Cleaner URLs** - `/alice/resources/xyz` vs `/.well-known/webvh/slug/resources/xyz`

## Files Modified

### Completed
- ✅ `src/lifecycle/LifecycleManager.ts` - publishToWeb method
- ✅ `src/vc/CredentialManager.ts` - signCredentialWithExternalSigner method
- ✅ `src/types/common.ts` - ExternalSigner import

### Pending
- ⏳ `src/lifecycle/LifecycleManager.ts` - batchPublishToWeb method
- ⏳ `tests/integration/WebVhPublish.test.ts`
- ⏳ `tests/integration/DidPeerToWebVhFlow.test.ts`
- ⏳ `apps/originals-explorer/server/__tests__/publish-to-web.test.ts`
- ⏳ `apps/originals-explorer/server/routes.ts`

## Breaking Changes

⚠️ **BREAKING**: The API signature has changed. All code calling `publishToWeb(asset, domain)` must be updated.

## Next Actions

1. Update `batchPublishToWeb` in `LifecycleManager.ts`
2. Update test suite to use new API
3. Update server routes to pass user's did:webvh
4. Update documentation and examples
5. Run tests to ensure everything works