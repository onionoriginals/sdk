# Task BE-04: Transfer Asset Ownership

**Estimated Time**: 6-8 hours  
**Priority**: 🟡 Medium  
**Dependencies**: None (can be done after any layer implementation)

---

## Objective

Implement asset ownership transfer functionality, allowing users to transfer assets to other users while maintaining provenance tracking and verifiable credentials.

---

## Context Files to Read

```bash
# SDK lifecycle manager - transferOwnership method
src/lifecycle/LifecycleManager.ts

# OriginalsAsset structure
src/lifecycle/OriginalsAsset.ts

# Complete lifecycle test (shows transfer flow)
tests/integration/CompleteLifecycle.e2e.test.ts

# Storage and schema
apps/originals-explorer/server/storage.ts
apps/originals-explorer/shared/schema.ts
```

---

## Background

Asset transfer allows ownership to change hands while:
- Preserving complete provenance history
- Updating credentials with new owner
- Maintaining all DIDs (peer, webvh, btco)
- Recording transfer event in provenance chain

Transfers can happen at any layer (peer, webvh, or btco).

---

## Requirements

### 1. Create Backend Endpoint

**Endpoint**: `POST /api/assets/:id/transfer`

**Input**:
```typescript
{
  recipientDid: string;      // Recipient's DID (did:webvh:domain.com:slug)
  recipientUserId?: string;  // Optional: Internal user ID if known
  notes?: string;            // Optional transfer notes
}
```

**Output**:
```typescript
{
  asset: {
    id: string;
    userId: string;          // UPDATED: New owner's user ID
    currentLayer: string;    // Unchanged
    didPeer: string;         // Unchanged
    didWebvh: string;        // Unchanged
    didBtco: string;         // Unchanged (if exists)
    credentials: object;     // UPDATED: New ownership credential
    provenance: {
      events: [
        // ... previous events
        {
          type: "transferred",
          fromDid: "did:webvh:...:oldowner",
          toDid: "did:webvh:...:newowner",
          timestamp: "2024-...",
          notes: "..."
        }
      ]
    };
  };
  originalsAsset: {
    did: string;
    resources: [...];
    provenance: ProvenanceChain;
    currentOwner: {
      did: string;
      userId: string;
    };
  };
}
```

### 2. Implementation Steps

#### Step 1: Validate Transfer Request

```typescript
const asset = await storage.getAsset(req.params.id);

if (!asset) {
  return res.status(404).json({ error: 'Asset not found' });
}

// Check current owner
if (asset.userId !== user.id) {
  return res.status(403).json({ error: 'Not authorized. You do not own this asset.' });
}

// Validate recipient DID format
const { recipientDid, recipientUserId, notes } = req.body;

if (!recipientDid) {
  return res.status(400).json({ error: 'recipientDid is required' });
}

if (!recipientDid.startsWith('did:')) {
  return res.status(400).json({ error: 'Invalid DID format' });
}

// Check recipient exists (optional)
let recipientUser;
if (recipientUserId) {
  recipientUser = await storage.getUser(recipientUserId);
  if (!recipientUser) {
    return res.status(404).json({ error: 'Recipient user not found' });
  }
} else {
  // Try to find user by DID
  recipientUser = await storage.getUserByDid(recipientDid);
}

// Prevent self-transfer
if (recipientUser && recipientUser.id === user.id) {
  return res.status(400).json({ error: 'Cannot transfer asset to yourself' });
}
```

#### Step 2: Reconstruct OriginalsAsset

```typescript
import { OriginalsAsset } from '@originals/sdk';

// Use current DID (could be peer, webvh, or btco)
const currentDid = asset.didBtco || asset.didWebvh || asset.didPeer;

const originalsAsset = new OriginalsAsset(
  currentDid,
  asset.didDocument,
  JSON.parse(asset.metadata || '{}').resources || [],
  asset.provenance
);
```

#### Step 3: Call SDK to Transfer

```typescript
import { originalsSdk } from './originals';

try {
  // Transfer ownership via SDK
  const transferredAsset = await originalsSdk.lifecycle.transferOwnership(
    originalsAsset,
    recipientDid,
    {
      notes: notes || `Transferred from ${user.did} to ${recipientDid}`
    }
  );
  
  console.log('Asset transferred to:', recipientDid);
  
} catch (error) {
  console.error('Transfer error:', error);
  return res.status(500).json({ 
    error: 'Failed to transfer ownership',
    details: error.message 
  });
}
```

#### Step 4: Update Database

```typescript
// Update asset ownership and provenance
const updatedAsset = await storage.updateAsset(asset.id, {
  userId: recipientUser?.id || null, // Update to new owner (or null if external)
  credentials: transferredAsset.credentials,
  provenance: transferredAsset.provenance,
  didDocument: transferredAsset.didDocument,
  metadata: {
    ...asset.metadata,
    lastTransfer: {
      fromDid: user.did,
      toDid: recipientDid,
      timestamp: new Date().toISOString(),
      notes
    }
  },
  updatedAt: new Date()
});

// Optional: Create notification for recipient
if (recipientUser) {
  await createTransferNotification({
    recipientId: recipientUser.id,
    assetId: asset.id,
    fromUser: user.username,
    message: `You received "${asset.title}" from ${user.username}`
  });
}
```

#### Step 5: Return Response

```typescript
res.json({
  asset: updatedAsset,
  originalsAsset: {
    did: transferredAsset.did,
    resources: transferredAsset.resources,
    provenance: transferredAsset.provenance,
    currentOwner: {
      did: recipientDid,
      userId: recipientUser?.id || null
    }
  }
});
```

### 3. Transfer History Endpoint

Create: `GET /api/assets/:id/transfer-history`

```typescript
app.get('/api/assets/:id/transfer-history', authenticateUser, async (req, res) => {
  try {
    const asset = await storage.getAsset(req.params.id);
    
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    // Extract transfer events from provenance
    const provenance = asset.provenance as any;
    const transfers = provenance?.events?.filter(e => e.type === 'transferred') || [];
    
    // Enrich with user data
    const enrichedTransfers = await Promise.all(
      transfers.map(async (transfer) => {
        const fromUser = await storage.getUserByDid(transfer.fromDid);
        const toUser = await storage.getUserByDid(transfer.toDid);
        
        return {
          ...transfer,
          fromUsername: fromUser?.username || 'Unknown',
          toUsername: toUser?.username || 'Unknown'
        };
      })
    );
    
    res.json({
      assetId: asset.id,
      assetTitle: asset.title,
      totalTransfers: enrichedTransfers.length,
      transfers: enrichedTransfers
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### 4. Verify Ownership Endpoint

Create: `GET /api/assets/:id/verify-ownership`

```typescript
app.get('/api/assets/:id/verify-ownership', async (req, res) => {
  try {
    const asset = await storage.getAsset(req.params.id);
    
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    // Get current owner from database
    const owner = await storage.getUser(asset.userId);
    
    // Verify against credentials
    const credentials = asset.credentials as any;
    const ownershipCred = credentials?.ownership;
    
    res.json({
      assetId: asset.id,
      assetTitle: asset.title,
      currentOwner: {
        userId: owner?.id,
        username: owner?.username,
        did: owner?.did
      },
      verifiedBy: 'credentials',
      issuedAt: ownershipCred?.issuanceDate,
      transferCount: asset.provenance?.events?.filter(e => e.type === 'transferred').length || 0
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### 5. Error Handling

Handle these cases:
- Asset not found → 404
- Not authorized (not owner) → 403
- Invalid recipient DID → 400
- Recipient not found → 404
- Self-transfer attempted → 400
- SDK transfer fails → 500
- Missing required fields → 400

---

## Validation Checklist

Before marking complete:

- [ ] Transfer endpoint updates ownership correctly
- [ ] Provenance tracks transfer event
- [ ] Credentials updated for new owner
- [ ] All DIDs preserved (peer, webvh, btco)
- [ ] Transfer history endpoint works
- [ ] Ownership verification works
- [ ] Cannot transfer if not owner
- [ ] Cannot self-transfer
- [ ] Recipient validation works
- [ ] Error handling comprehensive
- [ ] Notifications sent (if implemented)

---

## Testing

### Manual Test:

```bash
# 1. Create asset as User A
curl -X POST http://localhost:5000/api/assets/create-with-did \
  -H "Cookie: $USER_A_COOKIE" \
  -F "title=Transfer Test" \
  -F "mediaFile=@image.png"

ASSET_ID="orig_123..."

# 2. Get User B's DID
# (User B should already be registered)
USER_B_DID="did:webvh:example.com:userb"

# 3. Transfer from User A to User B
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/transfer \
  -H "Cookie: $USER_A_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{
    "recipientDid": "'$USER_B_DID'",
    "notes": "Gifting this to you!"
  }'

# Expected response:
# - asset.userId: <User B's ID>
# - provenance includes transfer event

# 4. Verify User B now owns it
curl -X GET http://localhost:5000/api/assets/$ASSET_ID \
  -H "Cookie: $USER_B_COOKIE"

# Should succeed (User B is owner)

# 5. Try to transfer as User A (should fail)
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/transfer \
  -H "Cookie: $USER_A_COOKIE" \
  -d '{"recipientDid": "did:webvh:example.com:userc"}'

# Should return 403 (not authorized)

# 6. View transfer history
curl -X GET http://localhost:5000/api/assets/$ASSET_ID/transfer-history \
  -H "Cookie: $USER_B_COOKIE"

# Should show 1 transfer from User A to User B
```

### Database Verification:

```sql
-- Check ownership changed
SELECT id, title, user_id, 
       provenance->'events' as events
FROM assets 
WHERE id = 'orig_123...';

-- Check transfer event in provenance
SELECT jsonb_array_elements(provenance->'events')->>'type' as event_type,
       jsonb_array_elements(provenance->'events')->>'fromDid' as from_did,
       jsonb_array_elements(provenance->'events')->>'toDid' as to_did
FROM assets
WHERE id = 'orig_123...';
```

---

## Success Criteria

✅ Task is complete when:
1. Endpoint transfers ownership correctly
2. Provenance records transfer event
3. Credentials updated for new owner
4. Transfer history accessible
5. Ownership verification works
6. Authorization checked properly
7. Cannot transfer to self
8. Error handling comprehensive
9. Manual testing passes
10. Database correctly updated

---

## Next Task

After completion, proceed to:
- **TASK_FE04_TRANSFER_UI.md** - Add transfer UI
