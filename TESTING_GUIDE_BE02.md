# Testing Guide: Task BE-02 - Publish Asset to Web

## Prerequisites

1. Server running on `localhost:5000`
2. Valid authentication cookie stored in `$AUTH_COOKIE`
3. Test image file available (e.g., `image.png`)

## Step-by-Step Testing

### Step 1: Create Asset (did:peer)

This creates an asset in the private `did:peer` layer.

```bash
curl -X POST http://localhost:5000/api/assets/create-with-did \
  -H "Cookie: $AUTH_COOKIE" \
  -F "title=Test Publish to Web" \
  -F "description=Testing migration from peer to webvh" \
  -F "mediaFile=@image.png" \
  -F "category=test"
```

**Expected Response:**
```json
{
  "asset": {
    "id": "orig_1234567890_abcd1234",
    "title": "Test Publish to Web",
    "currentLayer": "did:peer",
    "didPeer": "did:peer:2.Ez...",
    "didWebvh": null,
    "didBtco": null,
    "provenance": {
      "createdAt": "2025-10-06T...",
      "creator": "did:peer:2.Ez...",
      "migrations": [],
      "transfers": []
    },
    ...
  },
  "originalsAsset": {
    "did": "did:peer:2.Ez...",
    "resources": [...],
    "provenance": {...}
  }
}
```

**Store the asset ID:**
```bash
export ASSET_ID="orig_1234567890_abcd1234"
```

### Step 2: Verify Asset is in did:peer Layer

```bash
curl http://localhost:5000/api/assets/$ASSET_ID \
  -H "Cookie: $AUTH_COOKIE"
```

**Verify:**
- `currentLayer` should be `"did:peer"`
- `didPeer` should be populated
- `didWebvh` should be `null`
- `didBtco` should be `null`

### Step 3: Publish to Web (did:peer → did:webvh)

**Using default domain:**
```bash
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/publish-to-web \
  -H "Cookie: $AUTH_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**With custom domain:**
```bash
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/publish-to-web \
  -H "Cookie: $AUTH_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com"}'
```

**Expected Response:**
```json
{
  "asset": {
    "id": "orig_1234567890_abcd1234",
    "currentLayer": "did:webvh",
    "didPeer": "did:peer:2.Ez...",
    "didWebvh": "did:webvh:localhost%3A5000:...",
    "didDocument": {...},
    "credentials": {...},
    "provenance": {
      "createdAt": "2025-10-06T...",
      "creator": "did:peer:2.Ez...",
      "migrations": [
        {
          "from": "did:peer",
          "to": "did:webvh",
          "timestamp": "2025-10-06T..."
        }
      ],
      "transfers": []
    },
    "updatedAt": "2025-10-06T..."
  },
  "originalsAsset": {
    "did": "did:peer:2.Ez...",
    "previousDid": "did:peer:2.Ez...",
    "resources": [...],
    "provenance": {...}
  },
  "resolverUrl": "http://localhost:5000/.well-known/did/xyz123"
}
```

**Extract the slug:**
```bash
export SLUG="xyz123"  # Extract from didWebvh or resolverUrl
```

### Step 4: Verify DID Resolution

```bash
curl http://localhost:5000/.well-known/did/$SLUG
```

**Expected Response:**
```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:peer:2.Ez...",
  "verificationMethod": [...],
  ...
}
```

**Verify:**
- Content-Type header is `application/did+ld+json`
- DID document structure is valid
- Contains verification methods

### Step 5: Verify Asset State After Publishing

```bash
curl http://localhost:5000/api/assets/$ASSET_ID \
  -H "Cookie: $AUTH_COOKIE"
```

**Verify:**
- `currentLayer` is now `"did:webvh"`
- `didPeer` is still preserved (not null)
- `didWebvh` is populated
- `provenance.migrations` has one entry
- `provenance.migrations[0].from` is `"did:peer"`
- `provenance.migrations[0].to` is `"did:webvh"`

## Error Case Testing

### Test 1: Publish Non-Existent Asset

```bash
curl -X POST http://localhost:5000/api/assets/invalid_id/publish-to-web \
  -H "Cookie: $AUTH_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected:** HTTP 404 with error message "Asset not found"

### Test 2: Publish Without Authentication

```bash
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/publish-to-web \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected:** HTTP 401 with authentication error

### Test 3: Publish Already Published Asset

```bash
# First publish (should succeed)
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/publish-to-web \
  -H "Cookie: $AUTH_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{}'

# Second publish (should fail)
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/publish-to-web \
  -H "Cookie: $AUTH_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected:** HTTP 400 with error "Asset is already in did:webvh layer. Can only publish from did:peer."

### Test 4: Publish Asset Owned by Different User

```bash
# Use a different user's auth cookie
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/publish-to-web \
  -H "Cookie: $OTHER_USER_AUTH_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected:** HTTP 403 with error "Not authorized"

### Test 5: Resolve Non-Existent DID

```bash
curl http://localhost:5000/.well-known/did/nonexistent-slug
```

**Expected:** HTTP 404 with error "DID not found"

## Database Verification

If you have database access, verify the changes:

```sql
-- Check asset layer and DIDs
SELECT 
  id,
  title,
  current_layer,
  did_peer,
  did_webvh,
  did_btco,
  created_at,
  updated_at
FROM assets
WHERE id = 'orig_1234567890_abcd1234';

-- Check provenance
SELECT 
  id,
  title,
  provenance->'migrations' as migrations
FROM assets
WHERE current_layer = 'did:webvh'
ORDER BY updated_at DESC
LIMIT 5;

-- Count assets by layer
SELECT 
  current_layer,
  COUNT(*) as count
FROM assets
GROUP BY current_layer;
```

## Console Log Verification

Watch the server console for these log messages:

```
Creating asset with Originals SDK for user did:webvh:...
✅ Created did:peer: did:peer:2.Ez...
✅ Stored asset in database: orig_1234567890_abcd1234
Published to web: did:peer:2.Ez...
DID document published: did:webvh:localhost%3A5000:xyz123
```

## Success Checklist

After completing all tests, verify:

- [ ] Asset created in `did:peer` layer
- [ ] Asset successfully published to `did:webvh` layer
- [ ] `currentLayer` updated from `did:peer` to `did:webvh`
- [ ] `didPeer` preserved after publishing
- [ ] `didWebvh` populated with valid identifier
- [ ] Provenance contains migration event
- [ ] Migration event has correct `from` and `to` layers
- [ ] DID document is publicly accessible
- [ ] DID resolution returns valid DID document
- [ ] Cannot publish already-published asset (idempotent)
- [ ] Cannot publish asset without authentication
- [ ] Cannot publish asset owned by different user
- [ ] Error messages are clear and informative

## Tips for Debugging

1. **Check authentication:**
   ```bash
   curl http://localhost:5000/api/user \
     -H "Cookie: $AUTH_COOKIE"
   ```

2. **List all assets:**
   ```bash
   curl http://localhost:5000/api/assets \
     -H "Cookie: $AUTH_COOKIE"
   ```

3. **Filter assets by layer:**
   ```bash
   curl "http://localhost:5000/api/assets?layer=did:peer" \
     -H "Cookie: $AUTH_COOKIE"
   
   curl "http://localhost:5000/api/assets?layer=did:webvh" \
     -H "Cookie: $AUTH_COOKIE"
   ```

4. **Check server logs:**
   - Look for SDK creation/publish messages
   - Check for error stack traces
   - Verify DID format outputs

## Performance Testing

### Test Multiple Publishes

```bash
# Create and publish 10 assets
for i in {1..10}; do
  RESPONSE=$(curl -s -X POST http://localhost:5000/api/assets/create-with-did \
    -H "Cookie: $AUTH_COOKIE" \
    -F "title=Test Asset $i" \
    -F "mediaFile=@image.png")
  
  ASSET_ID=$(echo $RESPONSE | jq -r '.asset.id')
  
  echo "Publishing asset $ASSET_ID..."
  curl -X POST http://localhost:5000/api/assets/$ASSET_ID/publish-to-web \
    -H "Cookie: $AUTH_COOKIE" \
    -H "Content-Type: application/json" \
    -d '{}'
  
  echo "Asset $i published"
done
```

### Verify All Published

```bash
curl "http://localhost:5000/api/assets?layer=did:webvh" \
  -H "Cookie: $AUTH_COOKIE" | jq '.length'
```

**Expected:** Should return 10

## Integration Testing

### Full Lifecycle Test

```bash
#!/bin/bash

# 1. Create asset
echo "Creating asset..."
CREATE_RESPONSE=$(curl -s -X POST http://localhost:5000/api/assets/create-with-did \
  -H "Cookie: $AUTH_COOKIE" \
  -F "title=Lifecycle Test" \
  -F "mediaFile=@image.png")

ASSET_ID=$(echo $CREATE_RESPONSE | jq -r '.asset.id')
echo "Asset created: $ASSET_ID"

# 2. Verify it's in did:peer
LAYER=$(curl -s http://localhost:5000/api/assets/$ASSET_ID \
  -H "Cookie: $AUTH_COOKIE" | jq -r '.currentLayer')
echo "Current layer: $LAYER"

if [ "$LAYER" != "did:peer" ]; then
  echo "ERROR: Asset not in did:peer layer"
  exit 1
fi

# 3. Publish to web
echo "Publishing to web..."
PUBLISH_RESPONSE=$(curl -s -X POST http://localhost:5000/api/assets/$ASSET_ID/publish-to-web \
  -H "Cookie: $AUTH_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{}')

echo $PUBLISH_RESPONSE | jq '.'

# 4. Verify it's in did:webvh
LAYER=$(curl -s http://localhost:5000/api/assets/$ASSET_ID \
  -H "Cookie: $AUTH_COOKIE" | jq -r '.currentLayer')
echo "New layer: $LAYER"

if [ "$LAYER" != "did:webvh" ]; then
  echo "ERROR: Asset not in did:webvh layer"
  exit 1
fi

# 5. Get resolver URL and test it
RESOLVER_URL=$(echo $PUBLISH_RESPONSE | jq -r '.resolverUrl')
echo "Resolver URL: $RESOLVER_URL"

DID_DOC=$(curl -s $RESOLVER_URL)
echo "DID Document retrieved:"
echo $DID_DOC | jq '.'

# 6. Verify DID document structure
DID_ID=$(echo $DID_DOC | jq -r '.id')
if [ -z "$DID_ID" ] || [ "$DID_ID" == "null" ]; then
  echo "ERROR: Invalid DID document"
  exit 1
fi

echo "✅ All tests passed!"
```

## Notes

- Replace `$AUTH_COOKIE` with your actual authentication cookie
- Replace `image.png` with an actual image file path
- Adjust domain and port if not using `localhost:5000`
- Some responses are truncated for brevity - actual responses will be longer
- Make sure the Originals SDK is properly configured
