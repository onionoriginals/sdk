# Asset Migration Flow - Visual Overview

## Current Implementation Status

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ASSET LIFECYCLE FLOW                             │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│   did:peer       │      │   did:webvh      │      │   did:btco       │
│                  │      │                  │      │                  │
│  Private Layer   │ ───► │  Public Layer    │ ───► │  Bitcoin Layer   │
│  (Offline)       │      │  (HTTPS)         │      │  (Immutable)     │
└──────────────────┘      └──────────────────┘      └──────────────────┘
   Free, instant          $25/year hosting         $75-200 one-time


┌─────────────────────────────────────────────────────────────────────────┐
│                    IMPLEMENTATION STATUS MATRIX                          │
└─────────────────────────────────────────────────────────────────────────┘

Layer        │ SDK Status │ API Status │ UI Status │ Priority
─────────────┼────────────┼────────────┼───────────┼──────────
did:peer     │     ✅     │     ⚠️     │    ⚠️     │   🔴
did:webvh    │     ✅     │     ❌     │    ❌     │   🔴
did:btco     │     ✅     │     ❌     │    ❌     │   🟡
Transfer     │     ✅     │     ❌     │    ❌     │   🟢

Legend:
  ✅ = Fully implemented and tested
  ⚠️ = Partially implemented
  ❌ = Not implemented
  🔴 = High priority
  🟡 = Medium priority
  🟢 = Low priority / nice to have
```

---

## Detailed Component Flow

### 1. Asset Creation (did:peer) - PARTIALLY WORKING

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          ASSET CREATION FLOW                             │
└─────────────────────────────────────────────────────────────────────────┘

Frontend (create-asset-simple.tsx)
    │
    │ 1. User fills form
    │    - Title, description
    │    - Media file upload
    │    - Custom properties
    │
    ▼
┌────────────────────────────────┐
│  ⚠️  CURRENT IMPLEMENTATION    │ ← Problem: Doesn't use SDK!
│                                │
│  createAssetMutation.mutate({  │
│    title, description,         │
│    mediaUrl, metadata          │
│  })                            │
│                                │
│  → POST /api/assets            │
│  → Storage.createAsset()       │
│  → Database insert only        │
└────────────────────────────────┘
    │
    │ Result: Asset without DID ❌
    │
    ▼
Database (assets table)


┌────────────────────────────────┐
│  ✅ NEEDED IMPLEMENTATION      │ ← Solution: Use SDK!
│                                │
│  1. Hash media file (SHA-256)  │
│  2. Create AssetResource[]     │
│  3. POST /api/assets/create    │
└────────────────────────────────┘
    │
    ▼
Backend API (routes.ts)
    │
    ▼
┌────────────────────────────────┐
│  originalsSdk.lifecycle        │
│    .createAsset(resources)     │
│                                │
│  → Generates did:peer          │
│  → Creates DID document        │
│  → Generates keypair           │
│  → Stores in KeyStore          │
└────────────────────────────────┘
    │
    ▼
┌────────────────────────────────┐
│  Return OriginalsAsset         │
│                                │
│  {                             │
│    id: "did:peer:abc123...",   │
│    resources: [...],           │
│    did: { DID document },      │
│    currentLayer: "did:peer",   │
│    provenance: { ... }         │
│  }                             │
└────────────────────────────────┘
    │
    ▼
Database + Frontend Display
```

---

### 2. Web Publication (did:webvh) - NOT IMPLEMENTED

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      WEB PUBLICATION FLOW (NEEDED)                       │
└─────────────────────────────────────────────────────────────────────────┘

Frontend (NEW: publish-asset.tsx)
    │
    │ 1. List assets in did:peer layer
    │ 2. Select asset to publish
    │ 3. Confirm domain (e.g., myassets.com)
    │
    ▼
POST /api/assets/:id/publish-to-web
    │
    ▼
Backend API (routes.ts)
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│  1. Fetch asset from database                              │
│  2. Reconstruct OriginalsAsset object                      │
│  3. Call originalsSdk.lifecycle.publishToWeb(asset, domain)│
└────────────────────────────────────────────────────────────┘
    │
    ▼
SDK LifecycleManager.publishToWeb()
    │
    ├─► Upload resources to storage adapter
    │   │
    │   ├─► For each resource:
    │   │   - Generate content-addressed path
    │   │   - Upload to S3/storage
    │   │   - Get URL: https://domain/.well-known/webvh/{slug}/resources/{hash}
    │   │
    │   └─► Store URLs in resource.url
    │
    ├─► Create did:webvh binding
    │   │
    │   └─► did:webvh:myassets.com:{slug}
    │
    ├─► Issue ResourceMigrated credential
    │   │
    │   ├─► Sign with did:peer key
    │   └─► credentialSubject: { fromLayer: "did:peer", toLayer: "did:webvh" }
    │
    └─► Migrate asset layer
        │
        └─► asset.migrate("did:webvh", { ... })
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│  Return updated OriginalsAsset                             │
│                                                            │
│  {                                                         │
│    id: "did:peer:abc123...",                               │
│    currentLayer: "did:webvh",                              │
│    bindings: {                                             │
│      "did:webvh": "did:webvh:myassets.com:abc123"         │
│    },                                                      │
│    resources: [                                            │
│      { id, hash, url: "https://..." }                     │
│    ],                                                      │
│    credentials: [{ ResourceMigrated VC }],                │
│    provenance: {                                           │
│      migrations: [{ from: "did:peer", to: "did:webvh" }] │
│    }                                                       │
│  }                                                         │
└────────────────────────────────────────────────────────────┘
    │
    ▼
Update Database + Return to Frontend
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│  Frontend Display                                          │
│                                                            │
│  ✅ Published to Web!                                      │
│  📍 DID: did:webvh:myassets.com:abc123                     │
│  🔗 Resources accessible at:                               │
│     https://myassets.com/.well-known/webvh/abc123/...      │
│  📜 View provenance →                                      │
└────────────────────────────────────────────────────────────┘
```

---

### 3. Bitcoin Inscription (did:btco) - NOT IMPLEMENTED

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    BITCOIN INSCRIPTION FLOW (NEEDED)                     │
└─────────────────────────────────────────────────────────────────────────┘

Frontend (NEW: inscribe-asset.tsx)
    │
    │ 1. List assets in did:peer or did:webvh layers
    │ 2. Select asset to inscribe
    │ 3. Choose fee rate (sats/vB)
    │ 4. View cost estimate
    │ 5. Confirm inscription
    │
    ▼
POST /api/assets/:id/inscribe-on-bitcoin
    │
    ▼
Backend API (routes.ts)
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│  1. Fetch asset from database                              │
│  2. Reconstruct OriginalsAsset object                      │
│  3. Call originalsSdk.lifecycle.inscribeOnBitcoin(asset,   │
│     feeRate)                                               │
└────────────────────────────────────────────────────────────┘
    │
    ▼
SDK LifecycleManager.inscribeOnBitcoin()
    │
    ├─► Create inscription manifest
    │   │
    │   └─► {
    │         assetId: "did:peer:...",
    │         resources: [{ id, hash, contentType, url }],
    │         timestamp: "2025-10-04T..."
    │       }
    │
    ├─► Call BitcoinManager.inscribeData()
    │   │
    │   ├─► Get fee rate (from oracle or parameter)
    │   │
    │   ├─► Create inscription PSBT
    │   │   │
    │   │   ├─► Commit transaction
    │   │   │   - Contains inscription content
    │   │   │   - Pays to taproot address
    │   │   │
    │   │   └─► Reveal transaction
    │   │       - Reveals inscription on-chain
    │   │       - Assigns to specific satoshi
    │   │
    │   └─► Broadcast transactions
    │
    ├─► Record transaction details
    │   │
    │   └─► {
    │         commitTxId: "abc123...",
    │         revealTxId: "def456...",
    │         inscriptionId: "def456i0",
    │         satoshi: "1234567890",
    │         feeRate: 7
    │       }
    │
    ├─► Create did:btco binding
    │   │
    │   └─► did:btco:1234567890
    │
    └─► Migrate asset layer
        │
        └─► asset.migrate("did:btco", { transactionId, inscriptionId, satoshi, ... })
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│  Return updated OriginalsAsset                             │
│                                                            │
│  {                                                         │
│    id: "did:peer:abc123...",                               │
│    currentLayer: "did:btco",                               │
│    bindings: {                                             │
│      "did:webvh": "did:webvh:myassets.com:abc123",        │
│      "did:btco": "did:btco:1234567890"                    │
│    },                                                      │
│    provenance: {                                           │
│      migrations: [                                         │
│        { from: "did:peer", to: "did:webvh", ... },       │
│        {                                                   │
│          from: "did:webvh",                               │
│          to: "did:btco",                                  │
│          commitTxId: "abc123...",                         │
│          revealTxId: "def456...",                         │
│          inscriptionId: "def456i0",                       │
│          satoshi: "1234567890",                           │
│          feeRate: 7                                       │
│        }                                                   │
│      ]                                                     │
│    }                                                       │
│  }                                                         │
└────────────────────────────────────────────────────────────┘
    │
    ▼
Update Database + Return to Frontend
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│  Frontend Display                                          │
│                                                            │
│  ✅ Inscribed on Bitcoin!                                  │
│  📍 DID: did:btco:1234567890                               │
│  🔗 Inscription ID: def456i0                               │
│  ⛓️  Transaction: def456... (view on mempool.space)       │
│  📜 View provenance →                                      │
│  💸 Total cost: 15,234 sats (~$10.23 USD)                 │
└────────────────────────────────────────────────────────────┘
```

---

### 4. Ownership Transfer - NOT IMPLEMENTED

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      OWNERSHIP TRANSFER FLOW (NEEDED)                    │
└─────────────────────────────────────────────────────────────────────────┘

Frontend (NEW: transfer-asset.tsx)
    │
    │ 1. List assets in did:btco layer
    │ 2. Select asset to transfer
    │ 3. Enter recipient Bitcoin address
    │ 4. View transfer fee
    │ 5. Confirm transfer
    │
    ▼
POST /api/assets/:id/transfer
    │
    ▼
Backend API (routes.ts)
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│  1. Fetch asset from database                              │
│  2. Validate recipient address                             │
│  3. Call originalsSdk.lifecycle.transferOwnership(asset,   │
│     recipientAddress)                                      │
└────────────────────────────────────────────────────────────┘
    │
    ▼
SDK LifecycleManager.transferOwnership()
    │
    ├─► Validate asset is in did:btco layer
    │
    ├─► Create transfer PSBT
    │   │
    │   ├─► Input: Satoshi with inscription
    │   └─► Output: Recipient address
    │
    ├─► Sign and broadcast transaction
    │
    └─► Record transfer in provenance
        │
        └─► {
              from: "did:peer:abc123...",
              to: "bc1q...",
              transactionId: "xyz789...",
              timestamp: "2025-10-04T..."
            }
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│  Return transaction details                                │
│                                                            │
│  {                                                         │
│    txid: "xyz789...",                                      │
│    vin: [...],                                             │
│    vout: [...],                                            │
│    fee: 1234                                               │
│  }                                                         │
└────────────────────────────────────────────────────────────┘
    │
    ▼
Update Database + Return to Frontend
    │
    ▼
┌────────────────────────────────────────────────────────────┐
│  Frontend Display                                          │
│                                                            │
│  ✅ Ownership transferred!                                 │
│  📍 To: bc1q...                                             │
│  ⛓️  Transaction: xyz789... (view on mempool.space)       │
│  📜 View provenance →                                      │
│  💸 Transfer fee: 1,234 sats (~$0.83 USD)                 │
└────────────────────────────────────────────────────────────┘
```

---

## Resource Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         RESOURCE LIFECYCLE                               │
└─────────────────────────────────────────────────────────────────────────┘

1. CREATION (did:peer)
   ┌──────────────┐
   │  Media File  │
   └──────┬───────┘
          │
          ▼
   ┌─────────────────┐
   │  SHA-256 Hash   │ ← Computed in browser
   └──────┬──────────┘
          │
          ▼
   ┌─────────────────┐
   │  AssetResource  │
   │  {              │
   │    id,          │
   │    hash,        │
   │    contentType, │
   │    content      │ ← Inline or referenced
   │  }              │
   └──────┬──────────┘
          │
          ▼
   ┌─────────────────┐
   │  DID Document   │ ← References resources
   │  did:peer:...   │
   └─────────────────┘


2. PUBLICATION (did:webvh)
   ┌──────────────────────────┐
   │  Resource with hash      │
   └──────┬───────────────────┘
          │
          ▼
   ┌─────────────────────────────────────┐
   │  Upload to storage adapter          │
   │  → S3: s3://bucket/domain/...       │
   │  → Returns: https://cdn.../...      │
   └──────┬──────────────────────────────┘
          │
          ▼
   ┌─────────────────────────────────────┐
   │  Content-addressed URL:             │
   │  https://domain/.well-known/webvh/  │
   │    {slug}/resources/{hash}          │
   └──────┬──────────────────────────────┘
          │
          ▼
   ┌─────────────────────────────────────┐
   │  Resource object updated:           │
   │  {                                  │
   │    id,                              │
   │    hash,                            │
   │    contentType,                     │
   │    url: "https://..."  ← Added     │
   │  }                                  │
   └──────┬──────────────────────────────┘
          │
          ▼
   ┌─────────────────┐
   │  DID Document   │ ← Still references same resource
   │  did:webvh:...  │    by hash (now accessible)
   └─────────────────┘


3. INSCRIPTION (did:btco)
   ┌──────────────────────────┐
   │  Asset manifest          │
   │  {                       │
   │    assetId,              │
   │    resources: [          │
   │      { id, hash, url }   │ ← Includes web URLs
   │    ],                    │
   │    timestamp             │
   │  }                       │
   └──────┬───────────────────┘
          │
          ▼
   ┌─────────────────────────────────────┐
   │  Inscribe on Bitcoin                │
   │  → Commit TX: Contains manifest     │
   │  → Reveal TX: Inscribed on satoshi  │
   └──────┬──────────────────────────────┘
          │
          ▼
   ┌─────────────────────────────────────┐
   │  Inscription on blockchain          │
   │  Inscription ID: {txid}i{index}     │
   │  Satoshi: 1234567890                │
   │                                     │
   │  Content: Asset manifest (JSON)     │
   │  Points to: Web resources via URL   │
   └──────┬──────────────────────────────┘
          │
          ▼
   ┌─────────────────┐
   │  DID Binding    │
   │  did:btco:      │
   │    1234567890   │ ← Satoshi number
   └─────────────────┘
```

---

## Provenance Chain Example

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     COMPLETE PROVENANCE CHAIN                            │
└─────────────────────────────────────────────────────────────────────────┘

Asset: "Vintage Camera 001"

{
  "createdAt": "2025-10-04T10:00:00Z",
  "creator": "did:peer:2abc...def",
  "txid": "xyz789...",  ← Latest transaction

  "migrations": [
    {
      "from": "did:peer",
      "to": "did:webvh",
      "timestamp": "2025-10-04T11:30:00Z",
      "transactionId": null,  ← No blockchain TX
      "inscriptionId": null
    },
    {
      "from": "did:webvh",
      "to": "did:btco",
      "timestamp": "2025-10-04T14:00:00Z",
      "transactionId": "def456...",  ← Reveal TX
      "inscriptionId": "def456i0",
      "satoshi": "1234567890",
      "commitTxId": "abc123...",
      "revealTxId": "def456...",
      "feeRate": 7
    }
  ],

  "transfers": [
    {
      "from": "did:peer:2abc...def",
      "to": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
      "timestamp": "2025-10-04T16:00:00Z",
      "transactionId": "xyz789..."
    }
  ]
}

Timeline Visualization:

2025-10-04
───────────────────────────────────────────────────────────────►

10:00        11:30          14:00          16:00
  │            │              │              │
  ● ─────────► ● ─────────── ● ─────────── ●
Created    Published     Inscribed    Transferred
(peer)     (webvh)       (btco)       (new owner)
```

---

## Data Flow Summary

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        DATA STORAGE LOCATIONS                            │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   KeyStore       │    │   Database       │    │   Storage        │
│   (in-memory)    │    │   (PostgreSQL)   │    │   (S3/IPFS)      │
└──────────────────┘    └──────────────────┘    └──────────────────┘
       │                        │                        │
       │                        │                        │
   Private keys           Asset metadata          Resource files
   - Verification         - Title, desc           - Images
   - Method IDs           - Current layer         - Documents
   - Ed25519/ES256K       - DID documents         - Media
   - Signing keys         - Provenance            - Content

       │                        │                        │
       └────────────────────────┴────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   OriginalsAsset    │
                    │   (runtime object)  │
                    │                     │
                    │  Combines data from │
                    │  all three sources  │
                    └─────────────────────┘
```

---

## Critical Gaps Summary

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    WHAT'S MISSING - QUICK REFERENCE                      │
└─────────────────────────────────────────────────────────────────────────┘

Backend API Endpoints:
  ❌ POST /api/assets/create-with-did        (use SDK for creation)
  ❌ POST /api/assets/:id/publish-to-web     (migrate to webvh)
  ❌ POST /api/assets/:id/inscribe-on-bitcoin (migrate to btco)
  ❌ POST /api/assets/:id/transfer           (ownership transfer)
  ❌ GET  /api/assets/:id/verify             (verify credentials)

Frontend Pages:
  ⚠️ create-asset-simple.tsx                 (needs SDK integration)
  ❌ publish-asset.tsx                        (NEW - publish to web)
  ❌ inscribe-asset.tsx                       (NEW - inscribe on BTC)
  ❌ transfer-asset.tsx                       (NEW - transfer ownership)
  ❌ provenance-view.tsx                      (NEW - view provenance)

Infrastructure:
  ❌ S3StorageAdapter                         (production storage)
  ❌ OrdinalsClient configuration             (real Bitcoin provider)
  ❌ MempoolSpaceFeeOracle                    (real fee estimation)
  ❌ KeyStore persistence                     (secure key storage)

Database:
  ❌ Migration: Add current_layer column
  ❌ Migration: Add did_peer, did_webvh, did_btco columns
  ❌ Migration: Add provenance JSONB column
  ❌ Index: current_layer for filtering

Tests:
  ⚠️ Integration tests for new endpoints
  ⚠️ E2E tests for complete user flow
  ❌ Browser-based e2e tests (Playwright/Cypress)
```

---

*This diagram complements ASSET_MIGRATION_STATUS.md*
*Created: 2025-10-04*
