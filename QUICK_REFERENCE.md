# Quick Reference: New publishToWeb API

## TL;DR

**Old API:**
```typescript
publishToWeb(asset, 'example.com')
```

**New API:**
```typescript
publishToWeb(asset, 'did:webvh:example.com:alice')
// or
publishToWeb(asset, externalSigner)
```

## Resource URL Changes

| Before | After |
|--------|-------|
| `/.well-known/webvh/{slug}/resources/{hash}` | `/{userPath}/resources/{hash}` |
| `example.com/.well-known/webvh/abc/resources/xyz` | `example.com/alice/resources/xyz` |

## Parameter Options

### Option 1: DID String
```typescript
const publisherDid = 'did:webvh:example.com:alice';
await sdk.lifecycle.publishToWeb(asset, publisherDid);
```

### Option 2: External Signer
```typescript
const signer = {
  sign: async (input) => ({ proofValue: '...' }),
  getVerificationMethodId: () => 'did:webvh:example.com:alice#key-0'
};
await sdk.lifecycle.publishToWeb(asset, signer);
```

## Path Extraction

```typescript
// did:webvh:example.com:alice
// → Resource path: /alice/resources/

// did:webvh:example.com:projects:app1
// → Resource path: /projects/app1/resources/

// did:webvh:example.com:users:bob:assets
// → Resource path: /users/bob/assets/resources/
```

## Migration Checklist

- [ ] Replace `domain` parameter with `publisherDid`
- [ ] Update URL expectations (no `.well-known`)
- [ ] Update tests
- [ ] Update server routes
- [ ] Verify credential issuance works

## Common Errors

### Error: "Invalid publisherDid: must be a did:webvh identifier"
**Cause:** Passed a plain domain instead of DID
```typescript
// ❌ Wrong
publishToWeb(asset, 'example.com')

// ✅ Correct
publishToWeb(asset, 'did:webvh:example.com:alice')
```

### Error: "Invalid did:webvh format: must include domain and user path"
**Cause:** DID missing user path component
```typescript
// ❌ Wrong
publishToWeb(asset, 'did:webvh:example.com')

// ✅ Correct
publishToWeb(asset, 'did:webvh:example.com:alice')
```

## Complete Example

```typescript
import { OriginalsSDK } from '@originals/sdk';

const sdk = OriginalsSDK.create({ network: 'mainnet' });

// Create asset
const asset = await sdk.lifecycle.createAsset([{
  id: 'r1',
  type: 'data',
  contentType: 'text/plain',
  hash: 'abc123',
  content: 'Hello'
}]);

// Publish with DID
const publisherDid = 'did:webvh:example.com:alice';
const published = await sdk.lifecycle.publishToWeb(asset, publisherDid);

console.log(published.currentLayer);
// → 'did:webvh'

console.log(published.bindings['did:webvh']);
// → 'did:webvh:example.com:alice'

console.log(published.resources[0].url);
// → 'https://example.com/alice/resources/uEiAbc123...'
```

## Server Integration

```typescript
app.post('/api/assets/:id/publish', async (req, res) => {
  const user = req.user; // Authenticated user
  const asset = await getAsset(req.params.id);
  
  // Use user's did:webvh
  const publisherDid = user.didWebvh;
  
  const published = await sdk.lifecycle.publishToWeb(
    asset,
    publisherDid
  );
  
  res.json({ asset: published });
});
```

## Key Points

1. ✅ **DID Required**: Must pass `did:webvh` identifier
2. ✅ **No `.well-known`**: Paths derived from DID
3. ✅ **Signer Support**: Can use external signers
4. ✅ **Publisher Signs**: Credentials signed by publisher, not asset
5. ✅ **Path Flexibility**: Supports nested paths in DID