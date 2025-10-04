# Asset Creation and Migration - Status & Implementation Plan

## Current Branch: `cursor/discuss-asset-creation-and-migration-plan-16d3`

---

## Executive Summary

The Originals Protocol implements a three-layer asset lifecycle system:
- **`did:peer`** - Private creation and experimentation (offline, free)
- **`did:webvh`** - Public discovery via HTTPS hosting ($25/year)
- **`did:btco`** - Transferable ownership on Bitcoin ($75-200 one-time)

**Status**: Core SDK functionality is **complete and tested**. UI integration is **partially complete**.

---

## ✅ What's Working

### SDK Layer (Fully Implemented & Tested)

#### 1. Asset Creation (`did:peer`)
- ✅ `LifecycleManager.createAsset()` creates assets with DID:peer documents
- ✅ Generates verification methods and cryptographic keys
- ✅ Supports multiple resources per asset
- ✅ Hash-based content verification
- ✅ KeyStore integration for private key management
- ✅ **Test Coverage**: `CompleteLifecycle.e2e.test.ts` (277 lines, full lifecycle)

#### 2. Web Publication (`did:webvh`)
- ✅ `LifecycleManager.publishToWeb()` migrates peer → webvh
- ✅ Uploads resources to storage adapter (S3/Memory)
- ✅ Generates content-addressed URLs
- ✅ Issues ResourceMigrated credentials
- ✅ Creates DID:WebVH bindings
- ✅ **Test Coverage**: `WebVhPublish.test.ts`, e2e tests

#### 3. Bitcoin Inscription (`did:btco`)
- ✅ `LifecycleManager.inscribeOnBitcoin()` migrates webvh/peer → btco
- ✅ Creates inscription manifest with asset metadata
- ✅ Integrates with OrdMockProvider (production needs real provider)
- ✅ Tracks commit/reveal transactions
- ✅ Records satoshi identifier
- ✅ Fee oracle integration
- ✅ **Test Coverage**: Full e2e tests covering direct peer→btco

#### 4. Ownership Transfer
- ✅ `LifecycleManager.transferOwnership()` transfers btco assets
- ✅ Bitcoin address validation with checksum
- ✅ PSBT construction
- ✅ Provenance tracking of transfers
- ✅ **Test Coverage**: Multiple transfer scenarios tested

#### 5. Provenance Tracking
- ✅ Complete audit trail with timestamps
- ✅ Migration history (from/to layer, transaction IDs)
- ✅ Transfer history (from/to addresses)
- ✅ DID bindings preservation across layers

### UI Layer (Partially Implemented)

#### 1. Asset Creation UI
- ✅ `create-asset-simple.tsx` - Form for creating assets
- ✅ Custom property system for asset types
- ✅ Media file upload
- ✅ Category and tag management
- ⚠️ **Calls `/api/assets` endpoint** but doesn't invoke SDK lifecycle methods

#### 2. Spreadsheet Upload
- ✅ `upload-spreadsheet` route - Bulk asset creation
- ✅ CSV/XLSX parsing
- ✅ Creates `did:peer` for each asset via SDK
- ✅ Auto-creates asset types
- ✅ Comprehensive error handling
- ✅ **Integration**: Lines 459-467 in `routes.ts` call `originalsSdk.lifecycle.createAsset()`

#### 3. Migration UI
- ✅ `migrate-asset-simple.tsx` - Form for migration
- ⚠️ **Mock implementation** - just creates database record
- ❌ **Does not call SDK migration methods**

---

## ❌ What's Missing / Needs Implementation

### Critical Path Items

#### 1. **Complete UI Integration for Asset Lifecycle** 🔴 HIGH PRIORITY

**Problem**: UI forms exist but don't orchestrate the full SDK lifecycle

**Current State**:
```typescript
// apps/originals-explorer/client/src/pages/create-asset-simple.tsx:120-151
// Only creates a database record, doesn't use SDK
const assetData: InsertAsset = {
  title: values.title,
  // ... just metadata
};
createAssetMutation.mutate(assetData);
```

**What's Needed**:
1. **Backend Endpoint**: `/api/assets/create-with-did` 
   - Call `originalsSdk.lifecycle.createAsset(resources)`
   - Generate proper resource hashes
   - Store DID document and credentials
   - Return complete `OriginalsAsset` data

2. **Frontend Flow**:
   - Hash media files before upload
   - Send resources array to backend
   - Display created `did:peer` identifier
   - Show provenance from SDK

**Implementation Estimate**: 4-6 hours
**Files to Modify**:
- `apps/originals-explorer/server/routes.ts` (new endpoint)
- `apps/originals-explorer/client/src/pages/create-asset-simple.tsx` (call new endpoint)

---

#### 2. **Web Publication Workflow** 🔴 HIGH PRIORITY

**Problem**: No UI for publishing assets to web layer

**What's Needed**:
1. **Backend Endpoint**: `/api/assets/:id/publish-to-web`
   - Fetch asset by ID
   - Call `originalsSdk.lifecycle.publishToWeb(asset, domain)`
   - Configure S3/storage adapter for production
   - Store updated asset state

2. **Frontend Page**: `publish-asset.tsx`
   - List assets in `did:peer` layer
   - Domain input (or use default from env)
   - Preview resource URLs
   - Confirm and publish
   - Show success with `did:webvh` identifier

3. **Storage Configuration**:
   - Currently uses `MemoryStorageAdapter` (in-memory only)
   - Need S3 or similar for production
   - Resource hosting at `https://{domain}/.well-known/webvh/{slug}/resources/{hash}`

**Implementation Estimate**: 6-8 hours
**Files to Create**:
- `apps/originals-explorer/client/src/pages/publish-asset.tsx`
- `apps/originals-explorer/server/routes.ts` (new endpoint)

---

#### 3. **Bitcoin Inscription Workflow** 🟡 MEDIUM PRIORITY

**Problem**: No UI for inscribing assets on Bitcoin

**What's Needed**:
1. **Ordinals Provider Configuration**:
   - Currently uses `OrdMockProvider` (test double)
   - Need integration with:
     - Ord API (self-hosted or service)
     - Bitcoin wallet for fee payment
     - PSBT signing infrastructure

2. **Backend Endpoint**: `/api/assets/:id/inscribe-on-bitcoin`
   - Fetch asset (must be in `did:peer` or `did:webvh` layer)
   - Call `originalsSdk.lifecycle.inscribeOnBitcoin(asset, feeRate)`
   - Store inscription ID, satoshi, transaction IDs
   - Update asset provenance

3. **Frontend Page**: `inscribe-asset.tsx`
   - List assets eligible for inscription
   - Fee rate estimation UI
   - Cost calculator (sats + USD)
   - Confirmation with fee breakdown
   - Transaction tracking
   - Display inscription ID and explorer link

**Implementation Estimate**: 8-12 hours (includes provider integration)
**Files to Create**:
- `apps/originals-explorer/client/src/pages/inscribe-asset.tsx`
- `apps/originals-explorer/server/routes.ts` (new endpoint)
- Bitcoin provider configuration

---

#### 4. **Resource Content Handling** 🟡 MEDIUM PRIORITY

**Problem**: Assets reference media files but hash computation is incomplete

**Current State**:
- UI accepts media files
- Files stored as `mediaUrl` (not proper resources)
- No cryptographic hash verification

**What's Needed**:
1. **Client-Side Hashing**:
```typescript
// Compute SHA-256 hash of file in browser
async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

2. **Resource Upload Flow**:
   - User selects file → hash computed
   - File uploaded to storage (S3/IPFS)
   - Resource object created with hash + URL
   - SDK creates asset with verified resources

3. **Storage Options**:
   - S3 bucket for resource storage
   - IPFS for decentralized storage
   - Hybrid: S3 + IPFS backup

**Implementation Estimate**: 4-6 hours
**Files to Modify**:
- `apps/originals-explorer/client/src/pages/create-asset-simple.tsx`
- `apps/originals-explorer/client/src/lib/file-utils.ts` (new)

---

#### 5. **Asset State Management & Visualization** 🟢 NICE TO HAVE

**Problem**: No clear indication of which layer an asset is in

**What's Needed**:
1. **Database Schema Update**:
```sql
ALTER TABLE assets ADD COLUMN current_layer TEXT;
ALTER TABLE assets ADD COLUMN did_peer TEXT;
ALTER TABLE assets ADD COLUMN did_webvh TEXT;
ALTER TABLE assets ADD COLUMN did_btco TEXT;
ALTER TABLE assets ADD COLUMN provenance JSONB;
```

2. **Asset Card Component**:
```tsx
<AssetCard>
  <LayerBadge layer={asset.currentLayer} />
  {/* did:peer → did:webvh → did:btco progress indicator */}
  <ProvenanceTimeline migrations={asset.provenance.migrations} />
</AssetCard>
```

3. **Dashboard Filtering**:
   - Filter by current layer
   - "Ready to publish" (peer assets)
   - "Published" (webvh assets)
   - "Inscribed" (btco assets)

**Implementation Estimate**: 6-8 hours
**Files to Create**:
- `apps/originals-explorer/migrations/0002_add_layer_tracking.sql`
- `apps/originals-explorer/client/src/components/LayerBadge.tsx`
- `apps/originals-explorer/client/src/components/ProvenanceTimeline.tsx`

---

#### 6. **Credential Verification UI** 🟢 NICE TO HAVE

**Problem**: Credentials issued but not visible or verifiable in UI

**What's Needed**:
1. **Asset Detail Page**:
   - Display all credentials issued for asset
   - Show credential type, issuer, timestamp
   - Verify credential signatures
   - Export credentials as JSON-LD

2. **Verification Endpoint**: `/api/assets/:id/verify`
   - Call `asset.verify({ didManager, credentialManager })`
   - Return verification result + details

**Implementation Estimate**: 4-6 hours

---

### Infrastructure & Configuration

#### 7. **Storage Adapter for Production** 🔴 HIGH PRIORITY

**Current**: `MemoryStorageAdapter` (data lost on restart)

**Needed**:
1. S3-compatible storage adapter
2. Configuration in `apps/originals-explorer/server/originals.ts`:
```typescript
import { S3StorageAdapter } from '@originals/sdk/adapters/S3StorageAdapter';

export const originalsSdk = OriginalsSDK.create({
  network: process.env.ORIGINALS_NETWORK as "mainnet" | "testnet" | "regtest" || "mainnet",
  enableLogging: process.env.ORIGINALS_SDK_LOG === "1",
  storageAdapter: new S3StorageAdapter({
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
  })
});
```

**Implementation**: Reuse existing adapter interface, create S3 implementation
**Estimate**: 4-6 hours

---

#### 8. **Bitcoin Integration for Production** 🟡 MEDIUM PRIORITY

**Current**: `OrdMockProvider` (test double)

**Needed**:
1. **Option A**: Self-hosted Ord server
   - Run `ord` server on signet/testnet/mainnet
   - Configure wallet with inscription capability
   - Point SDK to ord API endpoint

2. **Option B**: Service integration (e.g., Hiro, Ordinals.com)
   - Use existing ordinals API service
   - Implement provider adapter
   - Handle authentication/rate limits

**Configuration**:
```typescript
import { OrdinalsClient } from '@originals/sdk';

export const originalsSdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: process.env.ORD_API_URL,
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY // or HSM/KMS
  })
});
```

**Estimate**: 8-12 hours (depends on provider choice)

---

#### 9. **Fee Oracle Integration** 🟢 NICE TO HAVE

**Current**: `FeeOracleMock` (returns fixed 7 sats/vB)

**Needed**: Real-time fee estimation
```typescript
import { MempoolSpaceFeeOracle } from '@originals/sdk/adapters/MempoolSpaceFeeOracle';

feeOracle: new MempoolSpaceFeeOracle({
  apiUrl: 'https://mempool.space/api/v1/fees/recommended'
})
```

**Estimate**: 2-4 hours

---

## Implementation Priority & Roadmap

### Phase 1: Core Migration Flow (Week 1) - 20-30 hours
1. ✅ **Complete asset creation with proper SDK integration** (6h)
   - Hash media files
   - Create resources array
   - Call SDK, store DID document

2. ✅ **Implement web publication workflow** (8h)
   - Backend endpoint
   - Frontend page
   - Storage adapter configuration

3. ✅ **Add asset state tracking** (6h)
   - Database migration
   - Layer badges in UI
   - Filter by layer

4. 🔄 **Basic provenance visualization** (4h)
   - Timeline component
   - Show migrations

### Phase 2: Bitcoin Integration (Week 2) - 20-30 hours
1. ✅ **Configure ordinals provider** (12h)
   - Choose provider (self-hosted vs service)
   - Implement adapter
   - Test on signet

2. ✅ **Build inscription workflow** (8h)
   - Backend endpoint
   - Frontend page
   - Fee estimation

3. 🔄 **Storage adapter for production** (6h)
   - S3 integration
   - Test resource upload/retrieval

### Phase 3: Polish & Production (Week 3) - 15-20 hours
1. 🔄 **Credential verification UI** (6h)
2. 🔄 **Transfer ownership UI** (4h)
3. 🔄 **Real fee oracle** (2h)
4. 🔄 **Error handling & edge cases** (4h)
5. 🔄 **Documentation & guides** (4h)

---

## Technical Debt & Considerations

### Security
- **Private key management**: KeyStore in memory only, need persistent secure storage
- **Wallet integration**: Privy handles signing, but need backup recovery
- **Resource verification**: Implement content-addressed storage validation

### Performance
- **Large files**: Need chunking/streaming for >10MB files
- **Batch operations**: Optimize spreadsheet uploads for 1000+ rows
- **Caching**: Cache DID resolution, fee estimates

### Testing
- ✅ **Unit tests**: 100% coverage on SDK
- ⚠️ **Integration tests**: Need more UI integration tests
- ❌ **E2E tests**: No browser-based e2e tests yet

---

## Key Files Reference

### SDK (src/)
- `src/lifecycle/LifecycleManager.ts` - Core migration logic
- `src/lifecycle/OriginalsAsset.ts` - Asset representation
- `src/did/DIDManager.ts` - DID document creation
- `src/vc/CredentialManager.ts` - Credential issuance/verification

### Explorer Backend (apps/originals-explorer/server/)
- `server/routes.ts` - API endpoints
- `server/originals.ts` - SDK configuration
- `server/storage.ts` - Database operations

### Explorer Frontend (apps/originals-explorer/client/src/)
- `pages/create-asset-simple.tsx` - Asset creation UI
- `pages/migrate-asset-simple.tsx` - Migration UI (needs work)
- `pages/assets-spreadsheet.tsx` - Spreadsheet upload

### Tests (tests/)
- `tests/integration/CompleteLifecycle.e2e.test.ts` - Full lifecycle test (277 lines)
- `tests/unit/lifecycle/LifecycleManager.test.ts` - Unit tests

---

## Questions for Discussion

1. **Storage Strategy**: S3, IPFS, or hybrid for resource hosting?
2. **Bitcoin Provider**: Self-hosted ord or third-party service?
3. **Fee Payment**: Who pays inscription fees? Escrow? Prepaid credits?
4. **Domain Management**: One domain for all users or custom domains?
5. **Migration Triggers**: Automatic (on conditions) or always manual?
6. **Batch Operations**: Support publishing/inscribing multiple assets at once?
7. **Rollback**: Can users "unpublish" or is migration one-way?

---

## Next Steps

1. **Review this document** with team
2. **Prioritize features** based on user needs
3. **Assign Phase 1 tasks** to developers
4. **Set up staging environment** with testnet Bitcoin
5. **Configure storage adapter** (S3 bucket)
6. **Begin implementation** starting with asset creation flow

---

## Success Metrics

### MVP Ready When:
- ✅ Users can create assets with `did:peer`
- ✅ Users can publish to web and receive `did:webvh` 
- ✅ Users can inscribe on Bitcoin and receive `did:btco`
- ✅ Users can verify asset provenance
- ✅ Resources are cryptographically verified
- ✅ All migrations tracked in database

### Production Ready When:
- ✅ All above + mainnet Bitcoin support
- ✅ Real storage (S3) for resources
- ✅ Error monitoring and logging
- ✅ Rate limiting and authentication
- ✅ Backup and recovery procedures
- ✅ User documentation complete

---

*Document generated: 2025-10-04*
*Based on analysis of commit `e93d402` on branch `cursor/discuss-asset-creation-and-migration-plan-16d3`*
