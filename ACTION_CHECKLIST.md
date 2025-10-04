# Asset Migration Implementation - Action Checklist

## Quick Start Guide

Use this checklist to implement the complete asset migration flow. Check off items as you complete them.

---

## 🔴 Phase 1: Core Asset Creation (Week 1)

### Task 1.1: Fix Asset Creation to Use SDK (6-8 hours)

**Backend Work** (`apps/originals-explorer/server/routes.ts`)

- [ ] Create new endpoint `POST /api/assets/create-with-did`
  ```typescript
  app.post("/api/assets/create-with-did", authenticateUser, async (req, res) => {
    // Implementation here
  });
  ```

- [ ] Implement resource hashing on server
  ```typescript
  const assetHash = crypto.createHash('sha256')
    .update(Buffer.from(content))
    .digest('hex');
  ```

- [ ] Call SDK to create asset
  ```typescript
  const originalsAsset = await originalsSdk.lifecycle.createAsset(resources);
  ```

- [ ] Store result in database with DID document
  ```typescript
  await storage.createAsset({
    ...assetData,
    didDocument: originalsAsset.did,
    didPeer: originalsAsset.id,
    currentLayer: 'did:peer',
    provenance: originalsAsset.getProvenance()
  });
  ```

- [ ] Return complete asset data including DID

**Frontend Work** (`apps/originals-explorer/client/src/pages/create-asset-simple.tsx`)

- [ ] Update mutation to call new endpoint
  ```typescript
  mutationFn: async (data) => {
    const response = await apiRequest("POST", "/api/assets/create-with-did", data);
    return response.json();
  }
  ```

- [ ] Display created `did:peer` identifier in success message

- [ ] Add link to view asset details and provenance

**Testing**

- [ ] Test creating asset with single resource
- [ ] Test creating asset with multiple resources
- [ ] Verify DID document stored correctly
- [ ] Verify provenance initialized

---

### Task 1.2: Add Database Columns for Layer Tracking (2 hours)

**Database Migration** (`apps/originals-explorer/migrations/0002_add_layer_tracking.sql`)

- [ ] Create migration file
  ```sql
  ALTER TABLE assets ADD COLUMN current_layer TEXT DEFAULT 'did:peer';
  ALTER TABLE assets ADD COLUMN did_peer TEXT;
  ALTER TABLE assets ADD COLUMN did_webvh TEXT;
  ALTER TABLE assets ADD COLUMN did_btco TEXT;
  ALTER TABLE assets ADD COLUMN provenance JSONB;
  
  CREATE INDEX idx_assets_current_layer ON assets(current_layer);
  CREATE INDEX idx_assets_did_peer ON assets(did_peer);
  CREATE INDEX idx_assets_did_btco ON assets(did_btco);
  ```

- [ ] Update schema in `shared/schema.ts`
  ```typescript
  export const assets = pgTable("assets", {
    // ... existing columns
    currentLayer: text("current_layer").default("did:peer"),
    didPeer: text("did_peer"),
    didWebvh: text("did_webvh"),
    didBtco: text("did_btco"),
    provenance: jsonb("provenance")
  });
  ```

- [ ] Run migration: `bun run drizzle-kit push`

- [ ] Update storage functions to handle new columns

**Testing**

- [ ] Verify migration runs successfully
- [ ] Test querying by current_layer
- [ ] Test storing provenance JSON

---

### Task 1.3: Create Layer Badge Component (2 hours)

**Component** (`apps/originals-explorer/client/src/components/LayerBadge.tsx`)

- [ ] Create badge component
  ```tsx
  export function LayerBadge({ layer }: { layer: 'did:peer' | 'did:webvh' | 'did:btco' }) {
    const config = {
      'did:peer': { color: 'gray', label: 'Private', icon: '🔒' },
      'did:webvh': { color: 'blue', label: 'Published', icon: '🌐' },
      'did:btco': { color: 'orange', label: 'Inscribed', icon: '⛓️' }
    };
    
    // ... render badge
  }
  ```

- [ ] Add to asset cards in dashboard

- [ ] Add filter dropdown for layer selection

**Testing**

- [ ] Verify badge displays correctly for each layer
- [ ] Test filtering by layer

---

### Task 1.4: Update Asset List to Show Current Layer (2 hours)

**Backend** (`apps/originals-explorer/server/routes.ts`)

- [ ] Update `GET /api/assets` to return `currentLayer` field

- [ ] Add optional `?layer=did:peer` query parameter for filtering
  ```typescript
  const { layer } = req.query;
  const assets = await storage.getAssetsByUserId(user.id, { layer });
  ```

**Frontend** (`apps/originals-explorer/client/src/pages/dashboard.tsx`)

- [ ] Display layer badge on each asset card

- [ ] Add filter controls above asset list
  ```tsx
  <LayerFilter 
    value={selectedLayer} 
    onChange={setSelectedLayer}
    options={['all', 'did:peer', 'did:webvh', 'did:btco']}
  />
  ```

**Testing**

- [ ] Verify assets display with correct layer
- [ ] Test filtering by layer
- [ ] Test "all" filter shows all assets

---

## 🔴 Phase 2: Web Publication Flow (Week 1-2)

### Task 2.1: Configure Storage Adapter (4-6 hours)

**Choose Storage Option:**

Option A: AWS S3 (Recommended for production)
- [ ] Create S3 bucket: `originals-resources-prod`
- [ ] Configure CORS for public read access
- [ ] Set up CloudFront CDN (optional but recommended)
- [ ] Add environment variables:
  ```env
  S3_BUCKET=originals-resources-prod
  S3_REGION=us-east-1
  AWS_ACCESS_KEY_ID=...
  AWS_SECRET_ACCESS_KEY=...
  ```

Option B: MemoryStorageAdapter (Development only)
- [ ] Keep current setup for testing
- [ ] Document that it's ephemeral

**Implementation** (`apps/originals-explorer/server/originals.ts`)

- [ ] Create S3 storage adapter implementation
  ```typescript
  import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
  
  export class S3StorageAdapter implements StorageAdapter {
    // Implementation
  }
  ```

- [ ] Update SDK configuration
  ```typescript
  export const originalsSdk = OriginalsSDK.create({
    network: process.env.ORIGINALS_NETWORK as any,
    storageAdapter: new S3StorageAdapter({
      bucket: process.env.S3_BUCKET!,
      region: process.env.S3_REGION!
    })
  });
  ```

**Testing**

- [ ] Test uploading file to S3
- [ ] Test retrieving file from S3
- [ ] Verify URLs are publicly accessible
- [ ] Test with large file (>10MB)

---

### Task 2.2: Implement Web Publication Endpoint (4 hours)

**Backend** (`apps/originals-explorer/server/routes.ts`)

- [ ] Create endpoint `POST /api/assets/:id/publish-to-web`
  ```typescript
  app.post("/api/assets/:id/publish-to-web", authenticateUser, async (req, res) => {
    const { id } = req.params;
    const { domain } = req.body;
    
    // 1. Fetch asset from database
    const asset = await storage.getAsset(id);
    
    // 2. Reconstruct OriginalsAsset from stored data
    const originalsAsset = reconstructAssetFromDB(asset);
    
    // 3. Publish to web
    const webAsset = await originalsSdk.lifecycle.publishToWeb(
      originalsAsset, 
      domain
    );
    
    // 4. Update database
    await storage.updateAsset(id, {
      currentLayer: 'did:webvh',
      didWebvh: webAsset.bindings['did:webvh'],
      provenance: webAsset.getProvenance(),
      // ... update resources with URLs
    });
    
    // 5. Return updated asset
    res.json(webAsset);
  });
  ```

- [ ] Implement `reconstructAssetFromDB()` helper
  ```typescript
  function reconstructAssetFromDB(dbAsset: any): OriginalsAsset {
    // Convert DB row to OriginalsAsset instance
    return new OriginalsAsset(
      dbAsset.resources,
      dbAsset.didDocument,
      dbAsset.credentials || []
    );
  }
  ```

**Testing**

- [ ] Test publishing asset with single resource
- [ ] Test publishing asset with multiple resources
- [ ] Verify resources uploaded to storage
- [ ] Verify URLs are accessible
- [ ] Verify provenance updated

---

### Task 2.3: Create Web Publication UI (4 hours)

**Frontend** (`apps/originals-explorer/client/src/pages/publish-asset.tsx`)

- [ ] Create new page component
  ```tsx
  export default function PublishAsset() {
    // 1. Fetch assets in did:peer layer
    // 2. Display list with "Publish" button
    // 3. Show domain input
    // 4. Call publish endpoint
    // 5. Show success message with did:webvh
  }
  ```

- [ ] Add form with domain input
  ```tsx
  <Form>
    <FormField name="domain" label="Domain">
      <Input 
        placeholder="myassets.com" 
        defaultValue={defaultDomain}
      />
    </FormField>
    <Button>Publish to Web</Button>
  </Form>
  ```

- [ ] Add mutation for publishing
  ```typescript
  const publishMutation = useMutation({
    mutationFn: async ({ assetId, domain }) => {
      return await apiRequest(
        "POST", 
        `/api/assets/${assetId}/publish-to-web`,
        { domain }
      );
    },
    onSuccess: (data) => {
      toast({
        title: "Published!",
        description: `Asset published to ${data.bindings['did:webvh']}`
      });
    }
  });
  ```

- [ ] Add route to `App.tsx`
  ```tsx
  <Route path="/publish" component={PublishAsset} />
  ```

- [ ] Add navigation link in header
  ```tsx
  <NavLink href="/publish">Publish Assets</NavLink>
  ```

**Testing**

- [ ] Test publishing single asset
- [ ] Test with custom domain
- [ ] Verify success message shows did:webvh
- [ ] Verify asset moves to "published" filter

---

## 🟡 Phase 3: Bitcoin Inscription Flow (Week 2)

### Task 3.1: Configure Bitcoin Provider (8-12 hours)

**Choose Provider Option:**

Option A: Self-hosted Ord (More control, more setup)
- [ ] Set up Bitcoin Core node (signet for testing)
- [ ] Install and configure Ord server
- [ ] Create inscription wallet
- [ ] Fund wallet with signet coins
- [ ] Configure Ord API access

Option B: Third-party service (Faster, less control)
- [ ] Research providers (Hiro, Ordinals.com API)
- [ ] Sign up for API access
- [ ] Get API credentials
- [ ] Review rate limits and pricing

**Implementation** (if using self-hosted)

- [ ] Create `OrdinalsClient` configuration
  ```typescript
  import { OrdinalsClient } from '@originals/sdk';
  
  export const originalsSdk = OriginalsSDK.create({
    network: process.env.BITCOIN_NETWORK as any,
    ordinalsProvider: new OrdinalsClient({
      network: process.env.BITCOIN_NETWORK,
      apiUrl: process.env.ORD_API_URL,
      walletPrivateKey: process.env.BITCOIN_WALLET_PRIVATE_KEY
    })
  });
  ```

- [ ] Add environment variables
  ```env
  BITCOIN_NETWORK=signet
  ORD_API_URL=http://localhost:80
  BITCOIN_WALLET_PRIVATE_KEY=...
  ```

**Testing**

- [ ] Test connection to Ord server
- [ ] Test creating test inscription
- [ ] Test retrieving inscription by ID
- [ ] Verify transaction broadcast

---

### Task 3.2: Implement Fee Estimation (2-4 hours)

**Implementation** (`src/adapters/MempoolSpaceFeeOracle.ts`)

- [ ] Create real fee oracle
  ```typescript
  export class MempoolSpaceFeeOracle implements FeeOracle {
    async estimateFeeRate(targetBlocks: number): Promise<number> {
      const response = await fetch(
        'https://mempool.space/api/v1/fees/recommended'
      );
      const fees = await response.json();
      
      if (targetBlocks <= 1) return fees.fastestFee;
      if (targetBlocks <= 3) return fees.halfHourFee;
      return fees.hourFee;
    }
  }
  ```

- [ ] Update SDK configuration
  ```typescript
  feeOracle: new MempoolSpaceFeeOracle()
  ```

**Testing**

- [ ] Test fee estimation returns reasonable values
- [ ] Test with different target block times
- [ ] Mock API calls in tests

---

### Task 3.3: Implement Inscription Endpoint (4 hours)

**Backend** (`apps/originals-explorer/server/routes.ts`)

- [ ] Create endpoint `POST /api/assets/:id/inscribe-on-bitcoin`
  ```typescript
  app.post("/api/assets/:id/inscribe-on-bitcoin", authenticateUser, async (req, res) => {
    const { id } = req.params;
    const { feeRate } = req.body;
    
    // 1. Fetch asset
    const asset = await storage.getAsset(id);
    
    // 2. Verify asset is in peer or webvh layer
    if (asset.currentLayer === 'did:btco') {
      return res.status(400).json({ 
        error: "Asset already inscribed" 
      });
    }
    
    // 3. Reconstruct asset
    const originalsAsset = reconstructAssetFromDB(asset);
    
    // 4. Inscribe on Bitcoin
    const btcoAsset = await originalsSdk.lifecycle.inscribeOnBitcoin(
      originalsAsset,
      feeRate
    );
    
    // 5. Update database
    await storage.updateAsset(id, {
      currentLayer: 'did:btco',
      didBtco: btcoAsset.bindings['did:btco'],
      provenance: btcoAsset.getProvenance()
    });
    
    // 6. Return result
    res.json(btcoAsset);
  });
  ```

- [ ] Add fee estimation endpoint
  ```typescript
  app.get("/api/bitcoin/fee-estimate", async (req, res) => {
    const { targetBlocks = 1 } = req.query;
    const feeRate = await originalsSdk.bitcoin.estimateFee(
      Number(targetBlocks)
    );
    res.json({ feeRate });
  });
  ```

**Testing**

- [ ] Test inscription with test wallet
- [ ] Verify transaction broadcast
- [ ] Verify provenance updated
- [ ] Test error handling for insufficient funds

---

### Task 3.4: Create Inscription UI (4-6 hours)

**Frontend** (`apps/originals-explorer/client/src/pages/inscribe-asset.tsx`)

- [ ] Create page component
  ```tsx
  export default function InscribeAsset() {
    // 1. Fetch assets in peer or webvh layers
    // 2. Fetch current fee estimate
    // 3. Calculate inscription cost
    // 4. Show confirmation dialog
    // 5. Call inscribe endpoint
  }
  ```

- [ ] Add fee calculator component
  ```tsx
  <FeeCalculator 
    feeRate={feeRate}
    estimatedSize={estimatedSize}
    onFeeChange={setFeeRate}
  />
  ```

- [ ] Add confirmation dialog
  ```tsx
  <ConfirmationDialog
    title="Inscribe Asset on Bitcoin"
    description={`This will cost approximately ${totalCost} sats (~${usdCost} USD)`}
    onConfirm={handleInscribe}
  />
  ```

- [ ] Add transaction tracking
  ```tsx
  <TransactionStatus
    status={inscriptionStatus}
    txid={revealTxId}
    explorerUrl={`https://mempool.space/tx/${revealTxId}`}
  />
  ```

**Testing**

- [ ] Test fee calculator updates correctly
- [ ] Test confirmation dialog
- [ ] Test inscription success flow
- [ ] Test error handling

---

## 🟢 Phase 4: Additional Features (Week 3)

### Task 4.1: Provenance Timeline UI (4 hours)

**Component** (`apps/originals-explorer/client/src/components/ProvenanceTimeline.tsx`)

- [ ] Create timeline component
  ```tsx
  export function ProvenanceTimeline({ provenance }) {
    return (
      <div className="timeline">
        <TimelineEvent 
          timestamp={provenance.createdAt}
          title="Asset Created"
          layer="did:peer"
        />
        {provenance.migrations.map(migration => (
          <TimelineEvent
            timestamp={migration.timestamp}
            title={`Migrated to ${migration.to}`}
            details={migration}
          />
        ))}
      </div>
    );
  }
  ```

- [ ] Add to asset detail page

---

### Task 4.2: Transfer Ownership UI (4 hours)

**Endpoint** (`apps/originals-explorer/server/routes.ts`)

- [ ] Create `POST /api/assets/:id/transfer`

**Frontend** (`apps/originals-explorer/client/src/pages/transfer-asset.tsx`)

- [ ] Create transfer form
- [ ] Add address validation
- [ ] Show transfer fee
- [ ] Implement transfer mutation

---

### Task 4.3: Credential Verification UI (4 hours)

**Endpoint** (`apps/originals-explorer/server/routes.ts`)

- [ ] Create `POST /api/assets/:id/verify`

**Frontend Component**

- [ ] Display credentials list
- [ ] Show verification status
- [ ] Add export functionality

---

## Testing Checklist

### Unit Tests
- [ ] Test asset creation with SDK
- [ ] Test resource hashing
- [ ] Test DID document generation
- [ ] Test provenance tracking

### Integration Tests
- [ ] Test complete peer → webvh flow
- [ ] Test complete webvh → btco flow
- [ ] Test peer → btco direct flow
- [ ] Test ownership transfer

### E2E Tests
- [ ] Test user creates asset in UI
- [ ] Test user publishes asset
- [ ] Test user inscribes asset
- [ ] Test user views provenance

---

## Documentation Tasks

- [ ] Update README with migration flow
- [ ] Document API endpoints
- [ ] Create user guide for asset lifecycle
- [ ] Document storage adapter setup
- [ ] Document Bitcoin provider setup
- [ ] Create troubleshooting guide

---

## Environment Setup

### Development
```env
ORIGINALS_NETWORK=regtest
ORIGINALS_SDK_LOG=true
S3_BUCKET=originals-dev
BITCOIN_NETWORK=signet
ORD_API_URL=http://localhost:80
```

### Staging
```env
ORIGINALS_NETWORK=testnet
S3_BUCKET=originals-staging
BITCOIN_NETWORK=testnet
```

### Production
```env
ORIGINALS_NETWORK=mainnet
S3_BUCKET=originals-prod
BITCOIN_NETWORK=mainnet
```

---

## Progress Tracking

Use this section to track overall progress:

**Week 1 Goals:**
- [x] Phase 1: Tasks 1.1-1.4 (Asset creation with SDK)
- [ ] Phase 2: Tasks 2.1-2.3 (Web publication)

**Week 2 Goals:**
- [ ] Phase 3: Tasks 3.1-3.4 (Bitcoin inscription)

**Week 3 Goals:**
- [ ] Phase 4: Additional features
- [ ] Testing and documentation
- [ ] Deployment to staging

---

## Notes & Blockers

Use this section to track issues:

- [ ] Issue: Need S3 bucket access → Owner: DevOps → ETA: Oct 5
- [ ] Issue: Ord server not configured → Owner: Backend → ETA: Oct 7
- [ ] Blocker: Waiting on API keys → Owner: PM → ETA: Oct 6

---

*Created: 2025-10-04*
*Last Updated: 2025-10-04*
