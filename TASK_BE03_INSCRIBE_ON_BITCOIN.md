# Task BE-03: Inscribe Asset on Bitcoin (did:btco)

**Estimated Time**: 10-12 hours  
**Priority**: 🟠 Medium  
**Dependencies**: TASK_BE02 must be complete

---

## Objective

Implement the "Inscribe on Bitcoin" functionality that migrates an asset from `did:webvh` (web layer) to `did:btco` (Bitcoin layer), creating an immutable, permanent record on the Bitcoin blockchain.

---

## Context Files to Read

```bash
# SDK lifecycle manager - inscribeOnBitcoin method
src/lifecycle/LifecycleManager.ts

# Bitcoin manager (handles inscription)
src/bitcoin/BitcoinManager.ts

# Ordinals provider interface
src/bitcoin/OrdinalsProvider.ts

# Complete lifecycle test (shows inscribe flow)
tests/integration/CompleteLifecycle.e2e.test.ts

# Storage and schema
apps/originals-explorer/server/storage.ts
apps/originals-explorer/shared/schema.ts
```

---

## Background

The final layer in the three-layer protocol:
1. **did:peer** → **did:webvh** (publish to web)
2. **did:webvh** → **did:btco** (inscribe on Bitcoin) ← **THIS TASK**

Bitcoin inscription creates a permanent, immutable record that cannot be altered or deleted.

---

## Requirements

### 1. Create Backend Endpoint

**Endpoint**: `POST /api/assets/:id/inscribe-on-bitcoin`

**Input**:
```typescript
{
  feeRate?: number;         // Optional: satoshis per vbyte (default: uses oracle)
  destinationAddress?: string;  // Optional: Bitcoin address for inscription
}
```

**Output**:
```typescript
{
  asset: {
    id: string;
    currentLayer: "did:btco";
    didPeer: string;        // Original (preserved)
    didWebvh: string;       // Web DID (preserved)
    didBtco: string;        // NEW: did:btco:txid:vout
    inscriptionId: string;  // Bitcoin inscription ID
    inscriptionTx: string;  // Transaction ID
    provenance: {
      events: [
        { type: "created", layer: "did:peer" },
        { type: "published", layer: "did:webvh" },
        { type: "inscribed", layer: "did:btco", txid: "...", block: 123 }  // NEW
      ]
    };
    // ...
  };
  originalsAsset: {
    did: string;           // Now did:btco
    previousDid: string;   // did:webvh
    inscriptionDetails: {
      txid: string;
      vout: number;
      blockHeight?: number;
      feeRate: number;
      totalCost: number;    // In satoshis
    };
  };
}
```

### 2. Implementation Steps

#### Step 1: Validate Asset State

```typescript
const asset = await storage.getAsset(req.params.id);

if (!asset) {
  return res.status(404).json({ error: 'Asset not found' });
}

if (asset.userId !== user.id) {
  return res.status(403).json({ error: 'Not authorized' });
}

// Must be in did:webvh to inscribe
if (asset.currentLayer !== 'did:webvh') {
  return res.status(400).json({ 
    error: `Asset is in ${asset.currentLayer} layer. Must be in did:webvh to inscribe on Bitcoin.`
  });
}

if (!asset.didWebvh) {
  return res.status(400).json({ 
    error: 'Asset missing did:webvh identifier. Publish to web first.' 
  });
}
```

#### Step 2: Reconstruct OriginalsAsset

```typescript
import { OriginalsAsset } from '@originals/sdk';

const originalsAsset = new OriginalsAsset(
  asset.didWebvh,
  asset.didDocument,
  JSON.parse(asset.metadata || '{}').resources || [],
  asset.provenance
);
```

#### Step 3: Check Bitcoin Network & Fees

```typescript
// Get current fee rates from oracle
const feeRate = req.body.feeRate || await originalsSdk.bitcoin.getFeeRate('medium');

// Estimate total cost
const estimate = await originalsSdk.bitcoin.estimateInscriptionCost({
  contentSize: calculateContentSize(originalsAsset),
  feeRate
});

console.log(`Inscription estimate: ${estimate.totalSats} sats (${estimate.totalBtc} BTC)`);

// Optional: Check user has sufficient balance (if managing wallets)
// const balance = await checkUserBitcoinBalance(user.id);
// if (balance < estimate.totalSats) {
//   return res.status(400).json({ error: 'Insufficient Bitcoin balance' });
// }
```

#### Step 4: Call SDK to Inscribe

```typescript
import { originalsSdk } from './originals';

try {
  // Inscribe on Bitcoin - creates did:btco
  const inscribedAsset = await originalsSdk.lifecycle.inscribeOnBitcoin(
    originalsAsset,
    {
      feeRate,
      destinationAddress: req.body.destinationAddress
    }
  );
  
  console.log('Inscribed on Bitcoin:', inscribedAsset.did);
  console.log('Transaction:', inscribedAsset.inscriptionTx);
  // inscribedAsset.did is now "did:btco:txid:vout"
  
} catch (error) {
  console.error('Inscription error:', error);
  
  if (error.message.includes('insufficient funds')) {
    return res.status(400).json({ 
      error: 'Insufficient Bitcoin for inscription',
      details: error.message 
    });
  }
  
  return res.status(500).json({ 
    error: 'Failed to inscribe on Bitcoin',
    details: error.message 
  });
}
```

#### Step 5: Update Database

```typescript
const updatedAsset = await storage.updateAsset(asset.id, {
  currentLayer: 'did:btco',
  didBtco: inscribedAsset.did,
  didDocument: inscribedAsset.didDocument,
  credentials: inscribedAsset.credentials,
  provenance: inscribedAsset.provenance,
  metadata: {
    ...asset.metadata,
    inscription: {
      txid: inscribedAsset.inscriptionTx,
      vout: extractVout(inscribedAsset.did),
      inscribedAt: new Date().toISOString(),
      feeRate,
      cost: estimate.totalSats
    }
  },
  updatedAt: new Date()
});
```

#### Step 6: Return Response

```typescript
res.json({
  asset: updatedAsset,
  originalsAsset: {
    did: inscribedAsset.did,
    previousDid: asset.didWebvh,
    inscriptionDetails: {
      txid: inscribedAsset.inscriptionTx,
      vout: extractVout(inscribedAsset.did),
      feeRate,
      totalCost: estimate.totalSats,
      explorerUrl: `https://mempool.space/tx/${inscribedAsset.inscriptionTx}`
    }
  }
});
```

### 3. Bitcoin Transaction Monitoring

Add optional webhook/polling to monitor inscription confirmation:

```typescript
// Optional: Start monitoring transaction
if (inscribedAsset.inscriptionTx) {
  monitorBitcoinTransaction(inscribedAsset.inscriptionTx, async (confirmations, blockHeight) => {
    if (confirmations >= 1) {
      // Update asset with block height
      await storage.updateAsset(asset.id, {
        metadata: {
          ...asset.metadata,
          inscription: {
            ...asset.metadata.inscription,
            confirmed: true,
            blockHeight,
            confirmations
          }
        }
      });
    }
  });
}
```

### 4. Fee Estimation Endpoint

Create helper endpoint: `GET /api/bitcoin/fee-estimate`

```typescript
app.get('/api/bitcoin/fee-estimate', authenticateUser, async (req, res) => {
  try {
    const { assetId } = req.query;
    
    if (!assetId) {
      return res.status(400).json({ error: 'assetId required' });
    }
    
    const asset = await storage.getAsset(assetId as string);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    // Get current fee rates
    const feeRates = {
      slow: await originalsSdk.bitcoin.getFeeRate('low'),
      medium: await originalsSdk.bitcoin.getFeeRate('medium'),
      fast: await originalsSdk.bitcoin.getFeeRate('high')
    };
    
    // Estimate costs for each fee rate
    const contentSize = calculateContentSize(asset);
    const estimates = {};
    
    for (const [speed, rate] of Object.entries(feeRates)) {
      const estimate = await originalsSdk.bitcoin.estimateInscriptionCost({
        contentSize,
        feeRate: rate
      });
      
      estimates[speed] = {
        feeRate: rate,
        totalSats: estimate.totalSats,
        totalBtc: estimate.totalBtc,
        estimatedTime: getEstimatedTime(speed)
      };
    }
    
    res.json({
      currentNetwork: process.env.BITCOIN_NETWORK || 'testnet',
      estimates
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function getEstimatedTime(speed: string): string {
  const times = {
    slow: '~2-4 hours',
    medium: '~30-60 minutes',
    fast: '~10-20 minutes'
  };
  return times[speed] || 'Unknown';
}
```

### 5. Error Handling

Handle these cases:
- Asset not found → 404
- Not authorized → 403
- Not in did:webvh layer → 400
- Insufficient Bitcoin balance → 400
- Bitcoin network error → 500
- Inscription fails → 500
- Invalid fee rate → 400
- Invalid destination address → 400

---

## Validation Checklist

Before marking complete:

- [ ] Endpoint creates valid `did:btco` identifier
- [ ] Asset's `currentLayer` updates to "did:btco"
- [ ] Previous DIDs preserved (didPeer, didWebvh)
- [ ] Bitcoin transaction ID stored
- [ ] Provenance tracks "inscribed" event
- [ ] Fee estimation endpoint works
- [ ] Can only inscribe from `did:webvh` layer
- [ ] Transaction confirmation monitoring works
- [ ] Error handling comprehensive
- [ ] Cost estimation accurate
- [ ] Explorer URL provides transaction link

---

## Testing

### Manual Test (Testnet):

```bash
# 1. Create asset → publish to web first
curl -X POST http://localhost:5000/api/assets/create-with-did \
  -H "Cookie: $AUTH_COOKIE" \
  -F "title=Bitcoin Test" \
  -F "mediaFile=@image.png"

ASSET_ID="orig_123..."

# 2. Publish to web
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/publish-to-web \
  -H "Cookie: $AUTH_COOKIE" \
  -d '{}'

# 3. Get fee estimate
curl "http://localhost:5000/api/bitcoin/fee-estimate?assetId=$ASSET_ID" \
  -H "Cookie: $AUTH_COOKIE"

# 4. Inscribe on Bitcoin
curl -X POST http://localhost:5000/api/assets/$ASSET_ID/inscribe-on-bitcoin \
  -H "Cookie: $AUTH_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{
    "feeRate": 10
  }'

# Expected response:
# - asset.currentLayer: "did:btco"
# - asset.didBtco: "did:btco:txid:vout"
# - inscriptionDetails.txid: "abc123..."
# - inscriptionDetails.explorerUrl: "https://mempool.space/tx/..."

# 5. Check transaction on block explorer
# Visit the explorerUrl from response
```

### Database Verification:

```sql
SELECT id, title, current_layer, 
       did_peer, did_webvh, did_btco,
       metadata->'inscription' as inscription_details
FROM assets 
WHERE current_layer = 'did:btco' 
ORDER BY updated_at DESC 
LIMIT 1;
```

---

## Important Notes

### Bitcoin Network Configuration

Ensure proper network configuration:

```typescript
// .env
BITCOIN_NETWORK=testnet  # or mainnet, signet
BITCOIN_RPC_URL=https://...
ORDINALS_PROVIDER_URL=https://...
```

### Cost Considerations

Bitcoin inscriptions cost real money:
- **Testnet**: Free (use testnet for development)
- **Signet**: Free (good for testing)
- **Mainnet**: Costs real BTC (typically $10-100+ depending on fees and size)

### Transaction Times

- Bitcoin blocks: ~10 minutes average
- Confirmation: 1-6 blocks recommended (10-60 minutes)
- During high congestion: Can take hours

---

## Success Criteria

✅ Task is complete when:
1. Endpoint inscribes assets from did:webvh to did:btco
2. Valid Bitcoin transaction created
3. did:btco identifier follows format: `did:btco:txid:vout`
4. Provenance tracks inscription event
5. All three DIDs preserved in database
6. Fee estimation works accurately
7. Transaction monitoring works
8. Error handling is comprehensive
9. Can view transaction on block explorer
10. Manual testing on testnet succeeds

---

## Next Task

After completion, proceed to:
- **TASK_FE03_INSCRIBE_UI.md** - Add inscribe button and fee display to UI
