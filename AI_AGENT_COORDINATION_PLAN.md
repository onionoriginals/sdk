# AI Agent Coordination Plan - Asset Migration Implementation

## Overview

This document provides prompts and tasks for coordinating a team of AI agents to implement the complete asset creation and migration system. Each task is designed to be executed independently by an AI coding agent.

---

## 🤖 Agent Team Structure

### Agent Roles

1. **Backend Agent** (2 agents) - API endpoints and SDK integration
2. **Frontend Agent** (2 agents) - UI components and pages  
3. **Database Agent** (1 agent) - Schema migrations and queries
4. **Infrastructure Agent** (1 agent) - Storage and Bitcoin provider setup
5. **Testing Agent** (1 agent) - Integration and E2E tests
6. **Coordinator Agent** (1 agent) - Integration and orchestration

---

## 📋 Task Dependency Graph

```
Database Migration (DB-01)
    ↓
Asset Creation Backend (BE-01)
    ↓
Asset Creation Frontend (FE-01)
    ↓
Asset Creation Tests (TEST-01)
    ↓
[Parallel Branch 1]              [Parallel Branch 2]
Storage Adapter (INFRA-01)       Bitcoin Provider (INFRA-02)
    ↓                                 ↓
Web Publication Backend (BE-02)   Inscription Backend (BE-03)
    ↓                                 ↓
Web Publication Frontend (FE-02)  Inscription Frontend (FE-03)
    ↓                                 ↓
Web Pub Tests (TEST-02)           Inscription Tests (TEST-03)
    ↓                                 ↓
    └─────────────┬───────────────────┘
                  ↓
         Transfer Backend (BE-04)
                  ↓
         Transfer Frontend (FE-04)
                  ↓
         Integration Tests (TEST-04)
                  ↓
         Final Validation (COORD-01)
```

---

## 🎯 Phase 1: Foundation (Week 1)

### Task DB-01: Database Schema Migration
**Agent**: Database Agent  
**Priority**: 🔴 Critical  
**Estimated Time**: 2 hours  
**Dependencies**: None

**Prompt**:
```
Create a database migration to add layer tracking and DID storage to the assets table.

Context:
- Database: PostgreSQL with Drizzle ORM
- Location: apps/originals-explorer/migrations/
- Existing schema: apps/originals-explorer/shared/schema.ts

Requirements:
1. Create migration file: 0002_add_layer_tracking.sql
2. Add columns:
   - current_layer TEXT DEFAULT 'did:peer'
   - did_peer TEXT
   - did_webvh TEXT
   - did_btco TEXT
   - provenance JSONB
3. Create indexes:
   - idx_assets_current_layer
   - idx_assets_did_peer
   - idx_assets_did_btco
4. Update schema.ts with new columns
5. Update storage.ts to handle new fields in:
   - createAsset()
   - updateAsset()
   - getAssetsByUserId() - add optional layer filter

Testing:
- Run migration locally
- Verify columns created
- Test inserting/querying with new fields

Files to modify:
- apps/originals-explorer/migrations/0002_add_layer_tracking.sql (new)
- apps/originals-explorer/shared/schema.ts
- apps/originals-explorer/server/storage.ts

Success criteria:
- Migration runs without errors
- Schema exports correct types
- Storage methods handle new fields
```

**Expected Output**:
- Migration SQL file
- Updated schema.ts
- Updated storage.ts with new methods
- Test verification that migration works

---

### Task BE-01: Asset Creation with SDK Integration
**Agent**: Backend Agent #1  
**Priority**: 🔴 Critical  
**Estimated Time**: 6 hours  
**Dependencies**: DB-01

**Prompt**:
```
Implement proper asset creation endpoint that uses the Originals SDK to create did:peer identifiers.

Context:
- Current implementation at POST /api/assets creates database records without DIDs
- SDK is already configured at apps/originals-explorer/server/originals.ts
- SDK method: originalsSdk.lifecycle.createAsset(resources: AssetResource[])

Requirements:

1. Create new endpoint: POST /api/assets/create-with-did
   - Location: apps/originals-explorer/server/routes.ts
   - Requires authentication (use authenticateUser middleware)
   
2. Request body schema:
   {
     title: string,
     description?: string,
     category: string,
     tags?: string[],
     mediaFile?: { content: string, contentType: string },
     customProperties?: Record<string, any>
   }

3. Implementation steps:
   a. Hash media file content (SHA-256)
   b. Create AssetResource array:
      - id: Generate unique ID
      - type: Infer from contentType
      - contentType: From request
      - hash: Computed SHA-256
      - content: File content
   
   c. Call SDK:
      const originalsAsset = await originalsSdk.lifecycle.createAsset(resources);
   
   d. Extract data from SDK response:
      - DID document: originalsAsset.did
      - DID identifier: originalsAsset.id
      - Resources: originalsAsset.resources
      - Provenance: originalsAsset.getProvenance()
   
   e. Store in database:
      await storage.createAsset({
        title,
        description,
        category,
        tags,
        metadata: { customProperties, fileType, fileSize },
        userId: user.id,
        assetType: "original",
        status: "completed",
        currentLayer: "did:peer",
        didPeer: originalsAsset.id,
        provenance: originalsAsset.getProvenance(),
        credentials: originalsAsset.credentials
      });
   
   f. Return complete asset data including DID

4. Error handling:
   - Validate required fields
   - Handle SDK errors gracefully
   - Return descriptive error messages

5. Update existing POST /api/assets to redirect to new endpoint
   OR deprecate and update frontend

Files to modify:
- apps/originals-explorer/server/routes.ts

Helper functions to create:
- hashContent(content: string | Buffer): string
- createAssetResources(mediaFile, metadata): AssetResource[]
- reconstructAssetFromDB(dbAsset): OriginalsAsset (for later use)

Testing:
- Test with single resource
- Test with multiple resources  
- Test without media file
- Verify DID document stored correctly
- Verify provenance initialized

Success criteria:
- Endpoint returns asset with valid did:peer identifier
- DID document stored in database
- Provenance contains createdAt and creator
- Frontend can call this endpoint successfully
```

**Expected Output**:
- New `/api/assets/create-with-did` endpoint
- Helper functions for hashing and resource creation
- Updated storage calls
- Error handling

---

### Task FE-01: Update Asset Creation UI
**Agent**: Frontend Agent #1  
**Priority**: 🔴 Critical  
**Estimated Time**: 4 hours  
**Dependencies**: BE-01

**Prompt**:
```
Update the asset creation form to call the new SDK-integrated backend endpoint.

Context:
- Current form: apps/originals-explorer/client/src/pages/create-asset-simple.tsx
- New backend endpoint: POST /api/assets/create-with-did
- Need to display the created DID to user

Requirements:

1. Update mutation to call new endpoint:
   
   const createAssetMutation = useMutation({
     mutationFn: async (data: CreateAssetData) => {
       const response = await apiRequest(
         "POST", 
         "/api/assets/create-with-did", 
         data
       );
       return response.json();
     },
     onSuccess: (data) => {
       // Show success with DID
       toast({
         title: "Asset Created!",
         description: `Created with identifier: ${data.didPeer}`
       });
       // Redirect to asset detail or dashboard
     }
   });

2. Add success modal/card showing:
   - ✅ "Asset Created Successfully"
   - DID identifier (copyable)
   - Layer badge showing "did:peer"
   - Link to view asset details
   - Button to "Publish to Web" (can be disabled for now)

3. Update form to handle media file properly:
   - Read file content for hashing
   - Include in request payload
   - Show upload progress if file is large

4. Add loading state:
   - "Creating asset..." while SDK processes
   - Disable form during creation

5. Error handling:
   - Display validation errors clearly
   - Show SDK errors in user-friendly way
   - Allow retry on failure

Files to modify:
- apps/originals-explorer/client/src/pages/create-asset-simple.tsx

Components to create:
- apps/originals-explorer/client/src/components/AssetCreatedSuccess.tsx
  - Display DID
  - Copy to clipboard button
  - Next actions

Testing:
- Test creating asset with all fields
- Test creating asset with minimal fields
- Test with large media file
- Verify DID displays correctly
- Test error states

Success criteria:
- Form successfully creates asset with DID
- DID displayed to user
- Success state is clear and helpful
- Errors handled gracefully
```

**Expected Output**:
- Updated create-asset-simple.tsx
- New AssetCreatedSuccess component
- Proper error handling
- Loading states

---

### Task FE-02: Layer Badge and Filtering
**Agent**: Frontend Agent #2  
**Priority**: 🟡 Medium  
**Estimated Time**: 3 hours  
**Dependencies**: DB-01

**Prompt**:
```
Create a layer badge component and add layer filtering to the asset list.

Context:
- Assets can be in three layers: did:peer, did:webvh, did:btco
- Need visual indication of current layer
- Need ability to filter assets by layer

Requirements:

1. Create LayerBadge component:
   Location: apps/originals-explorer/client/src/components/LayerBadge.tsx
   
   Props:
   - layer: 'did:peer' | 'did:webvh' | 'did:btco'
   - size?: 'sm' | 'md' | 'lg'
   - showIcon?: boolean
   
   Design:
   - did:peer: Gray badge, 🔒 icon, "Private"
   - did:webvh: Blue badge, 🌐 icon, "Published"  
   - did:btco: Orange badge, ⛓️ icon, "Inscribed"
   
   Style: Match existing UI (minimal, clean)

2. Create LayerFilter component:
   Location: apps/originals-explorer/client/src/components/LayerFilter.tsx
   
   Props:
   - value: string (current filter)
   - onChange: (layer: string) => void
   
   Options:
   - "All Assets"
   - "Private (did:peer)"
   - "Published (did:webvh)"
   - "Inscribed (did:btco)"

3. Update Dashboard to use components:
   Location: apps/originals-explorer/client/src/pages/dashboard.tsx
   
   Changes:
   - Add LayerFilter above asset list
   - Add LayerBadge to each asset card
   - Update useQuery to include layer filter:
     const { data: assets } = useQuery({
       queryKey: ["/api/assets", { layer: selectedLayer }],
       queryFn: async () => {
         const params = selectedLayer !== 'all' 
           ? `?layer=${selectedLayer}` 
           : '';
         return apiRequest("GET", `/api/assets${params}`);
       }
     });

4. Update backend to handle layer filter:
   Location: apps/originals-explorer/server/routes.ts
   
   Modify GET /api/assets endpoint:
   - Accept ?layer=did:peer query param
   - Pass to storage.getAssetsByUserId(userId, { layer })

Files to modify:
- apps/originals-explorer/client/src/components/LayerBadge.tsx (new)
- apps/originals-explorer/client/src/components/LayerFilter.tsx (new)
- apps/originals-explorer/client/src/pages/dashboard.tsx
- apps/originals-explorer/server/routes.ts (minor update)

Testing:
- Verify badge displays correctly for each layer
- Test filtering by each layer
- Test "All Assets" shows everything
- Verify badge styling matches design system

Success criteria:
- LayerBadge component reusable and styled
- LayerFilter works with query params
- Dashboard shows current layer for all assets
- Filtering updates list correctly
```

**Expected Output**:
- LayerBadge.tsx component
- LayerFilter.tsx component
- Updated dashboard with filtering
- Backend filter support

---

### Task TEST-01: Asset Creation Integration Tests
**Agent**: Testing Agent  
**Priority**: 🟡 Medium  
**Estimated Time**: 3 hours  
**Dependencies**: BE-01, FE-01

**Prompt**:
```
Create integration tests for the asset creation flow with SDK integration.

Context:
- New endpoint: POST /api/assets/create-with-did
- SDK integration for DID creation
- Need to verify end-to-end flow

Requirements:

1. Backend integration tests:
   Location: apps/originals-explorer/server/__tests__/asset-creation.test.ts (new)
   
   Test cases:
   - "creates asset with valid data and returns DID"
   - "hashes media file content correctly"
   - "stores DID document in database"
   - "initializes provenance with creation timestamp"
   - "returns 400 for missing required fields"
   - "returns 401 for unauthenticated requests"
   - "handles SDK errors gracefully"
   
   Use actual SDK (not mocked) with test configuration

2. Frontend component tests:
   Location: apps/originals-explorer/client/src/pages/__tests__/create-asset-simple.test.tsx
   
   Test cases:
   - "renders form with all fields"
   - "validates required fields"
   - "calls API with correct payload"
   - "displays success message with DID"
   - "handles API errors"
   - "disables form during submission"
   
   Use React Testing Library and MSW for API mocking

3. E2E test (optional, nice to have):
   Location: apps/originals-explorer/e2e/asset-creation.spec.ts (new)
   
   Flow:
   - User logs in
   - Navigates to create asset page
   - Fills form with valid data
   - Submits form
   - Sees success message with DID
   - Asset appears in dashboard with did:peer badge
   
   Use Playwright or Cypress

Files to create:
- apps/originals-explorer/server/__tests__/asset-creation.test.ts
- apps/originals-explorer/client/src/pages/__tests__/create-asset-simple.test.tsx
- apps/originals-explorer/e2e/asset-creation.spec.ts (optional)

Setup:
- Configure test database
- Mock authentication where needed
- Use test storage adapter

Success criteria:
- All backend tests pass
- All frontend tests pass
- E2E test covers happy path
- Tests can run in CI
```

**Expected Output**:
- Backend integration tests
- Frontend component tests
- Optional E2E test
- Test utilities and mocks

---

## 🚀 Phase 2: Web Publication (Week 1-2)

### Task INFRA-01: Configure S3 Storage Adapter
**Agent**: Infrastructure Agent  
**Priority**: 🔴 Critical  
**Estimated Time**: 4 hours  
**Dependencies**: None (can run in parallel)

**Prompt**:
```
Implement and configure AWS S3 storage adapter for resource hosting.

Context:
- SDK uses StorageAdapter interface for publishing resources
- Current implementation uses MemoryStorageAdapter (ephemeral)
- Need persistent storage for production

Requirements:

1. Install AWS SDK:
   - Add @aws-sdk/client-s3 to package.json
   - Add @aws-sdk/s3-request-presigner for signed URLs

2. Create S3 storage adapter:
   Location: src/storage/S3StorageAdapter.ts
   
   Interface to implement:
   export interface StorageAdapter {
     put(objectKey: string, data: Buffer, options?: { contentType?: string }): Promise<string>;
     get(objectKey: string): Promise<{ content: Buffer; contentType: string } | null>;
     delete(objectKey: string): Promise<boolean>;
   }
   
   Implementation:
   - Use S3 PutObject for upload
   - Return public URL or CloudFront URL
   - Handle errors and retries
   - Support content-type metadata
   
   Configuration:
   - Bucket name from env: S3_BUCKET
   - Region from env: S3_REGION
   - Credentials from env or IAM role
   - Optional CloudFront domain: CLOUDFRONT_DOMAIN

3. Update SDK configuration:
   Location: apps/originals-explorer/server/originals.ts
   
   ```typescript
   import { S3StorageAdapter } from '@originals/sdk/storage/S3StorageAdapter';
   
   const storageAdapter = process.env.NODE_ENV === 'production'
     ? new S3StorageAdapter({
         bucket: process.env.S3_BUCKET!,
         region: process.env.S3_REGION!,
         cloudfrontDomain: process.env.CLOUDFRONT_DOMAIN
       })
     : new MemoryStorageAdapter(); // Keep for development
   
   export const originalsSdk = OriginalsSDK.create({
     network: process.env.ORIGINALS_NETWORK as any,
     enableLogging: process.env.ORIGINALS_SDK_LOG === "1",
     storageAdapter
   });
   ```

4. Environment variables:
   - Add to .env.example:
     ```
     S3_BUCKET=originals-resources-dev
     S3_REGION=us-east-1
     AWS_ACCESS_KEY_ID=your_key
     AWS_SECRET_ACCESS_KEY=your_secret
     CLOUDFRONT_DOMAIN=cdn.example.com (optional)
     ```

5. S3 bucket setup script:
   Location: scripts/setup-s3-bucket.sh
   
   - Create bucket
   - Enable public read for resources
   - Configure CORS
   - Set up lifecycle rules (optional)

Files to create:
- src/storage/S3StorageAdapter.ts
- scripts/setup-s3-bucket.sh
- Update apps/originals-explorer/server/originals.ts

Testing:
- Unit tests for S3StorageAdapter
- Test upload and retrieval
- Test with actual S3 bucket (dev)
- Verify public URL access

Success criteria:
- S3StorageAdapter implements interface correctly
- Files upload successfully to S3
- Public URLs are accessible
- SDK can use adapter for publishing
```

**Expected Output**:
- S3StorageAdapter implementation
- Updated SDK configuration
- S3 setup script
- Environment variable documentation
- Tests

---

### Task BE-02: Web Publication Endpoint
**Agent**: Backend Agent #2  
**Priority**: 🔴 Critical  
**Estimated Time**: 4 hours  
**Dependencies**: INFRA-01, BE-01

**Prompt**:
```
Implement web publication endpoint that migrates assets from did:peer to did:webvh.

Context:
- SDK method: originalsSdk.lifecycle.publishToWeb(asset, domain)
- Assets must be in did:peer layer to publish
- Publishing uploads resources to storage and creates did:webvh binding

Requirements:

1. Create endpoint: POST /api/assets/:id/publish-to-web
   Location: apps/originals-explorer/server/routes.ts
   
   Request body:
   {
     domain?: string // Optional, use default if not provided
   }
   
   Default domain: Use from env ORIGINALS_DEFAULT_DOMAIN or 'originals.build'

2. Implementation:
   
   ```typescript
   app.post("/api/assets/:id/publish-to-web", authenticateUser, async (req, res) => {
     const { id } = req.params;
     const { domain = process.env.ORIGINALS_DEFAULT_DOMAIN } = req.body;
     
     try {
       // 1. Fetch asset from database
       const dbAsset = await storage.getAsset(id);
       if (!dbAsset) {
         return res.status(404).json({ error: "Asset not found" });
       }
       
       // 2. Verify ownership
       if (dbAsset.userId !== user.id) {
         return res.status(403).json({ error: "Forbidden" });
       }
       
       // 3. Verify asset is in did:peer layer
       if (dbAsset.currentLayer !== 'did:peer') {
         return res.status(400).json({ 
           error: `Asset already in ${dbAsset.currentLayer} layer` 
         });
       }
       
       // 4. Reconstruct OriginalsAsset instance from DB
       const originalsAsset = reconstructAssetFromDB(dbAsset);
       
       // 5. Publish to web using SDK
       const webAsset = await originalsSdk.lifecycle.publishToWeb(
         originalsAsset,
         domain
       );
       
       // 6. Extract updated data
       const provenance = webAsset.getProvenance();
       const didWebvh = webAsset.bindings['did:webvh'];
       
       // 7. Update database
       await storage.updateAsset(id, {
         currentLayer: 'did:webvh',
         didWebvh,
         provenance,
         // Update resources with URLs
         metadata: {
           ...dbAsset.metadata,
           resources: webAsset.resources.map(r => ({
             id: r.id,
             hash: r.hash,
             url: r.url,
             contentType: r.contentType
           }))
         }
       });
       
       // 8. Return success
       res.json({
         success: true,
         asset: {
           id: dbAsset.id,
           currentLayer: 'did:webvh',
           didPeer: dbAsset.didPeer,
           didWebvh,
           provenance
         }
       });
       
     } catch (error) {
       console.error("Error publishing to web:", error);
       res.status(500).json({ 
         error: "Failed to publish asset",
         message: error.message 
       });
     }
   });
   ```

3. Implement reconstructAssetFromDB helper:
   ```typescript
   function reconstructAssetFromDB(dbAsset: any): OriginalsAsset {
     const resources = dbAsset.metadata?.resources || [];
     const didDocument = dbAsset.didDocument;
     const credentials = dbAsset.credentials || [];
     
     const asset = new OriginalsAsset(resources, didDocument, credentials);
     
     // Restore provenance
     if (dbAsset.provenance) {
       (asset as any).provenance = dbAsset.provenance;
     }
     
     // Restore current layer
     (asset as any).currentLayer = dbAsset.currentLayer;
     
     return asset;
   }
   ```

4. Error handling:
   - Asset not found → 404
   - Not owner → 403
   - Wrong layer → 400 with clear message
   - Storage adapter error → 500 with details
   - SDK error → 500 with details

Files to modify:
- apps/originals-explorer/server/routes.ts

Helper functions to create:
- reconstructAssetFromDB(dbAsset): OriginalsAsset

Testing:
- Test successful publication
- Test with custom domain
- Test with default domain
- Test publishing already-published asset (should fail)
- Test unauthorized access
- Verify resources uploaded to storage
- Verify URLs in response are accessible

Success criteria:
- Endpoint successfully publishes asset
- Resources uploaded and accessible
- did:webvh created and stored
- Provenance updated with migration
- Database reflects new state
```

**Expected Output**:
- `/api/assets/:id/publish-to-web` endpoint
- reconstructAssetFromDB helper
- Error handling
- Tests

---

### Task FE-03: Web Publication UI
**Agent**: Frontend Agent #1  
**Priority**: 🔴 Critical  
**Estimated Time**: 5 hours  
**Dependencies**: BE-02

**Prompt**:
```
Create UI for publishing assets to the web layer (did:webvh).

Context:
- Users need to select assets in did:peer layer and publish them
- Publishing makes resources publicly accessible via HTTPS
- Backend endpoint: POST /api/assets/:id/publish-to-web

Requirements:

1. Create publish page:
   Location: apps/originals-explorer/client/src/pages/publish-asset.tsx
   
   Layout:
   - Header: "Publish Assets to Web"
   - Description: "Make your private assets publicly discoverable"
   - Filter: Show only did:peer assets
   - Asset grid/list with "Publish" button for each
   - Publish modal for confirmation

2. Asset list:
   - Fetch assets with layer='did:peer'
   - Display title, description, thumbnail
   - Show LayerBadge (did:peer)
   - "Publish" button on each card
   
   ```tsx
   const { data: assets, isLoading } = useQuery({
     queryKey: ["/api/assets", { layer: "did:peer" }],
     queryFn: async () => {
       return apiRequest("GET", "/api/assets?layer=did:peer");
     }
   });
   ```

3. Publish modal:
   Component: PublishAssetModal
   
   Content:
   - Asset preview
   - Domain input (optional, show default)
   - Explanation of what publishing does
   - Cost: Free (storage costs apply)
   - Confirmation checkbox
   - "Publish" button
   
   ```tsx
   interface PublishModalProps {
     asset: Asset;
     isOpen: boolean;
     onClose: () => void;
   }
   
   export function PublishAssetModal({ asset, isOpen, onClose }: PublishModalProps) {
     const [domain, setDomain] = useState(defaultDomain);
     const [confirmed, setConfirmed] = useState(false);
     
     const publishMutation = useMutation({
       mutationFn: async () => {
         return apiRequest(
           "POST",
           `/api/assets/${asset.id}/publish-to-web`,
           { domain }
         );
       },
       onSuccess: (data) => {
         toast({
           title: "Published Successfully!",
           description: `Asset now available at ${data.didWebvh}`
         });
         queryClient.invalidateQueries(["/api/assets"]);
         onClose();
       }
     });
     
     // ... render modal
   }
   ```

4. Success state:
   After successful publish:
   - Show success toast with did:webvh
   - Update asset list (remove from did:peer list)
   - Option to view published asset
   - Share links to resources

5. Error handling:
   - Show validation errors
   - Handle network errors
   - Display clear error messages
   - Allow retry

6. Add route and navigation:
   - Route: /publish
   - Add to header navigation
   - Add to dashboard "Quick Actions"

Files to create:
- apps/originals-explorer/client/src/pages/publish-asset.tsx
- apps/originals-explorer/client/src/components/PublishAssetModal.tsx

Files to modify:
- apps/originals-explorer/client/src/App.tsx (add route)
- apps/originals-explorer/client/src/components/layout/header.tsx (add nav link)

Testing:
- Test asset list loads correctly
- Test publish modal opens/closes
- Test domain input (custom and default)
- Test successful publish flow
- Test error states
- Verify asset moves to did:webvh layer

Success criteria:
- Page displays publishable assets
- Modal provides clear explanation
- Publish process is smooth
- Success state is clear
- Errors handled gracefully
- Asset state updates correctly
```

**Expected Output**:
- publish-asset.tsx page
- PublishAssetModal component
- Routes and navigation
- Error handling
- Tests

---

## ⛓️ Phase 3: Bitcoin Inscription (Week 2)

### Task INFRA-02: Configure Bitcoin Ordinals Provider
**Agent**: Infrastructure Agent  
**Priority**: 🟡 Medium  
**Estimated Time**: 8 hours  
**Dependencies**: None (can run in parallel)

**Prompt**:
```
Set up Bitcoin Ordinals provider for inscriptions. Choose between self-hosted Ord or service.

Context:
- SDK needs OrdinalsProvider for Bitcoin inscriptions
- Current implementation uses OrdMockProvider (test double)
- Need real Bitcoin integration for testnet/mainnet

Decision required: Self-hosted Ord vs Third-party service

Option A: Self-Hosted Ord (Recommended for full control)
=========================================================

Requirements:

1. Set up Bitcoin Core node:
   - Install Bitcoin Core (v24.0+)
   - Configure for signet (testing) or mainnet (production)
   - Create bitcoin.conf:
     ```
     server=1
     rpcuser=originals
     rpcpassword=<secure_password>
     rpcallowip=127.0.0.1
     txindex=1
     signet=1  # For testing
     ```
   - Sync blockchain (signet: ~1GB, mainnet: ~500GB)

2. Install Ord:
   - Install from source or binary
   - Create ord.yaml config:
     ```yaml
     bitcoin_rpc_url: http://localhost:38332  # Signet port
     bitcoin_rpc_username: originals
     bitcoin_rpc_password: <secure_password>
     ```
   - Start ord server: `ord server`
   - Verify API: `curl http://localhost:80/inscriptions`

3. Create inscription wallet:
   - Generate wallet: `ord wallet create`
   - Export descriptor
   - Fund wallet with signet coins (use faucet)
   - Verify balance: `ord wallet balance`

4. Configure SDK:
   Location: apps/originals-explorer/server/originals.ts
   
   ```typescript
   import { OrdinalsClient } from '@originals/sdk';
   
   const ordinalsProvider = new OrdinalsClient({
     network: process.env.BITCOIN_NETWORK as any,
     apiUrl: process.env.ORD_API_URL || 'http://localhost:80',
     auth: {
       username: process.env.ORD_RPC_USER,
       password: process.env.ORD_RPC_PASSWORD
     }
   });
   
   export const originalsSdk = OriginalsSDK.create({
     network: process.env.ORIGINALS_NETWORK as any,
     ordinalsProvider,
     // ...
   });
   ```

5. Environment variables:
   ```
   BITCOIN_NETWORK=signet
   ORD_API_URL=http://localhost:80
   ORD_RPC_USER=originals
   ORD_RPC_PASSWORD=<secure_password>
   ```

Option B: Third-Party Service (Faster setup, less control)
===========================================================

1. Choose provider:
   - Hiro API (https://docs.hiro.so/ordinals)
   - Ordinals.com API
   - Research and select

2. Sign up and get API key:
   - Create account
   - Get API credentials
   - Review rate limits and pricing

3. Implement service adapter:
   Location: src/adapters/providers/HiroOrdinalsProvider.ts
   
   Implement OrdinalsProvider interface:
   - createInscription()
   - getInscriptionById()
   - transferInscription()
   - getInscriptionsBySatoshi()

4. Configure SDK with service provider

Both Options:
=============

1. Implement fee estimation:
   Location: src/adapters/MempoolSpaceFeeOracle.ts
   
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

2. Update SDK config:
   ```typescript
   feeOracle: new MempoolSpaceFeeOracle()
   ```

3. Create setup documentation:
   Location: docs/BITCOIN_SETUP.md
   - Step-by-step instructions
   - Troubleshooting guide
   - Security best practices

Files to create/modify:
- apps/originals-explorer/server/originals.ts
- src/adapters/MempoolSpaceFeeOracle.ts
- src/adapters/providers/HiroOrdinalsProvider.ts (if using service)
- docs/BITCOIN_SETUP.md
- scripts/setup-bitcoin-node.sh (if self-hosting)

Testing:
- Test connection to Ord/service
- Create test inscription
- Retrieve inscription by ID
- Verify fee estimation works
- Test on signet before mainnet

Success criteria:
- Bitcoin provider configured and working
- Can create test inscriptions
- Fee estimation returns reasonable values
- Documentation clear and complete
- Secure credential management
```

**Expected Output**:
- Bitcoin provider configured (Ord or service)
- Fee oracle implementation
- Setup documentation
- Test inscriptions
- Security configuration

---

### Task BE-03: Inscription Endpoint
**Agent**: Backend Agent #1  
**Priority**: 🔴 Critical  
**Estimated Time**: 5 hours  
**Dependencies**: INFRA-02

**Prompt**:
```
Implement Bitcoin inscription endpoint that migrates assets to did:btco layer.

Context:
- SDK method: originalsSdk.lifecycle.inscribeOnBitcoin(asset, feeRate)
- Assets can be in did:peer or did:webvh layer
- Inscription creates permanent on-chain record

Requirements:

1. Create endpoint: POST /api/assets/:id/inscribe-on-bitcoin
   Location: apps/originals-explorer/server/routes.ts
   
   Request body:
   {
     feeRate?: number // Optional, uses fee oracle if not provided
   }

2. Implementation:
   
   ```typescript
   app.post("/api/assets/:id/inscribe-on-bitcoin", authenticateUser, async (req, res) => {
     const { id } = req.params;
     const { feeRate } = req.body;
     
     try {
       // 1. Fetch asset
       const dbAsset = await storage.getAsset(id);
       if (!dbAsset) {
         return res.status(404).json({ error: "Asset not found" });
       }
       
       // 2. Verify ownership
       if (dbAsset.userId !== user.id) {
         return res.status(403).json({ error: "Forbidden" });
       }
       
       // 3. Verify asset not already inscribed
       if (dbAsset.currentLayer === 'did:btco') {
         return res.status(400).json({ 
           error: "Asset already inscribed on Bitcoin" 
         });
       }
       
       // 4. Reconstruct asset
       const originalsAsset = reconstructAssetFromDB(dbAsset);
       
       // 5. Inscribe on Bitcoin
       // This may take 10-30 seconds
       const btcoAsset = await originalsSdk.lifecycle.inscribeOnBitcoin(
         originalsAsset,
         feeRate
       );
       
       // 6. Extract inscription data
       const provenance = btcoAsset.getProvenance();
       const latestMigration = provenance.migrations[provenance.migrations.length - 1];
       const didBtco = btcoAsset.bindings['did:btco'];
       
       // 7. Update database
       await storage.updateAsset(id, {
         currentLayer: 'did:btco',
         didBtco,
         provenance,
         metadata: {
           ...dbAsset.metadata,
           inscription: {
             inscriptionId: latestMigration.inscriptionId,
             satoshi: latestMigration.satoshi,
             revealTxId: latestMigration.revealTxId,
             commitTxId: latestMigration.commitTxId,
             feeRate: latestMigration.feeRate
           }
         }
       });
       
       // 8. Return success with transaction details
       res.json({
         success: true,
         asset: {
           id: dbAsset.id,
           currentLayer: 'did:btco',
           didBtco,
           inscription: {
             inscriptionId: latestMigration.inscriptionId,
             satoshi: latestMigration.satoshi,
             revealTxId: latestMigration.revealTxId,
             explorerUrl: `https://mempool.space/tx/${latestMigration.revealTxId}`
           }
         }
       });
       
     } catch (error) {
       console.error("Error inscribing on Bitcoin:", error);
       
       // Provide helpful error messages
       if (error.message.includes('insufficient funds')) {
         return res.status(400).json({
           error: "Insufficient funds",
           message: "The inscription wallet does not have enough Bitcoin"
         });
       }
       
       res.status(500).json({ 
         error: "Failed to inscribe asset",
         message: error.message 
       });
     }
   });
   ```

3. Create fee estimation endpoint:
   
   ```typescript
   app.get("/api/bitcoin/fee-estimate", async (req, res) => {
     try {
       const { targetBlocks = 1 } = req.query;
       const feeRate = await originalsSdk.bitcoin.estimateFee(
         Number(targetBlocks)
       );
       
       res.json({ 
         feeRate,
         targetBlocks: Number(targetBlocks),
         estimatedCostSats: Math.ceil(feeRate * 150), // Rough estimate
         timestamp: new Date().toISOString()
       });
     } catch (error) {
       res.status(500).json({ error: "Failed to estimate fee" });
     }
   });
   ```

4. Create cost calculator endpoint:
   
   ```typescript
   app.post("/api/bitcoin/calculate-inscription-cost", async (req, res) => {
     try {
       const { assetId, feeRate } = req.body;
       
       // Get asset to estimate size
       const asset = await storage.getAsset(assetId);
       if (!asset) {
         return res.status(404).json({ error: "Asset not found" });
       }
       
       // Estimate inscription size
       const manifest = {
         assetId: asset.id,
         resources: asset.metadata?.resources || [],
         timestamp: new Date().toISOString()
       };
       const manifestSize = Buffer.from(JSON.stringify(manifest)).length;
       
       // Estimate vBytes (rough)
       const estimatedVBytes = Math.ceil(manifestSize * 4 + 150);
       
       // Calculate cost
       const costSats = Math.ceil(estimatedVBytes * feeRate);
       
       res.json({
         feeRate,
         estimatedVBytes,
         costSats,
         costBTC: costSats / 100000000
       });
     } catch (error) {
       res.status(500).json({ error: "Failed to calculate cost" });
     }
   });
   ```

5. Error handling:
   - Asset not found → 404
   - Already inscribed → 400
   - Insufficient funds → 400 with helpful message
   - Network error → 500 with retry suggestion
   - Timeout → 504 with status check endpoint

Files to modify:
- apps/originals-explorer/server/routes.ts

Testing:
- Test successful inscription (signet)
- Test fee estimation
- Test cost calculation
- Test already-inscribed error
- Test insufficient funds error
- Verify transaction on explorer
- Verify provenance updated

Success criteria:
- Inscription completes successfully
- Transaction broadcasted to network
- Inscription ID and satoshi recorded
- Provenance updated correctly
- Explorer link accessible
- Error handling comprehensive
```

**Expected Output**:
- `/api/assets/:id/inscribe-on-bitcoin` endpoint
- `/api/bitcoin/fee-estimate` endpoint  
- `/api/bitcoin/calculate-inscription-cost` endpoint
- Error handling
- Tests

---

### Task FE-04: Bitcoin Inscription UI
**Agent**: Frontend Agent #2  
**Priority**: 🔴 Critical  
**Estimated Time**: 6 hours  
**Dependencies**: BE-03

**Prompt**:
```
Create comprehensive UI for inscribing assets on Bitcoin.

Context:
- Users need to understand costs before inscribing
- Inscription is irreversible and costs money
- Need clear cost breakdown and confirmation
- Backend endpoints: inscription, fee estimate, cost calculator

Requirements:

1. Create inscribe page:
   Location: apps/originals-explorer/client/src/pages/inscribe-asset.tsx
   
   Layout:
   - Header: "Inscribe Assets on Bitcoin"
   - Info banner: Explains permanence and cost
   - Filter: Show did:peer and did:webvh assets
   - Asset grid with "Inscribe" button
   - Inscription modal for confirmation

2. Asset list:
   ```tsx
   const { data: assets } = useQuery({
     queryKey: ["/api/assets", { inscribable: true }],
     queryFn: async () => {
       // Fetch assets in peer or webvh layers
       const response = await apiRequest("GET", "/api/assets");
       const data = await response.json();
       return data.filter(a => 
         a.currentLayer === 'did:peer' || 
         a.currentLayer === 'did:webvh'
       );
     }
   });
   ```

3. Fee selector component:
   Component: FeeSelectorWithEstimate
   Location: apps/originals-explorer/client/src/components/FeeSelectorWithEstimate.tsx
   
   ```tsx
   export function FeeSelectorWithEstimate({ onFeeChange }) {
     const [targetBlocks, setTargetBlocks] = useState(1);
     
     const { data: feeEstimate } = useQuery({
       queryKey: ["/api/bitcoin/fee-estimate", { targetBlocks }],
       queryFn: async () => {
         return apiRequest("GET", `/api/bitcoin/fee-estimate?targetBlocks=${targetBlocks}`);
       },
       refetchInterval: 60000 // Refresh every minute
     });
     
     useEffect(() => {
       if (feeEstimate) {
         onFeeChange(feeEstimate.feeRate);
       }
     }, [feeEstimate]);
     
     return (
       <div>
         <label>Confirmation Speed</label>
         <Select value={targetBlocks} onChange={setTargetBlocks}>
           <option value={1}>Fast (~10 min) - {feeEstimate?.feeRate} sat/vB</option>
           <option value={3}>Medium (~30 min)</option>
           <option value={6}>Slow (~1 hour)</option>
         </Select>
       </div>
     );
   }
   ```

4. Inscription modal:
   Component: InscribeAssetModal
   Location: apps/originals-explorer/client/src/components/InscribeAssetModal.tsx
   
   ```tsx
   export function InscribeAssetModal({ asset, isOpen, onClose }) {
     const [feeRate, setFeeRate] = useState(0);
     const [confirmed, setConfirmed] = useState(false);
     
     // Get cost estimate
     const { data: costEstimate } = useQuery({
       queryKey: ["/api/bitcoin/calculate-inscription-cost", { assetId: asset.id, feeRate }],
       queryFn: async () => {
         return apiRequest("POST", "/api/bitcoin/calculate-inscription-cost", {
           assetId: asset.id,
           feeRate
         });
       },
       enabled: feeRate > 0
     });
     
     const inscribeMutation = useMutation({
       mutationFn: async () => {
         return apiRequest(
           "POST",
           `/api/assets/${asset.id}/inscribe-on-bitcoin`,
           { feeRate }
         );
       },
       onSuccess: (data) => {
         toast({
           title: "Inscribed on Bitcoin!",
           description: (
             <div>
               <p>Inscription ID: {data.inscription.inscriptionId}</p>
               <a href={data.inscription.explorerUrl} target="_blank">
                 View on Explorer →
               </a>
             </div>
           )
         });
         queryClient.invalidateQueries(["/api/assets"]);
         onClose();
       }
     });
     
     return (
       <Modal isOpen={isOpen} onClose={onClose}>
         <h2>Inscribe on Bitcoin</h2>
         
         {/* Asset preview */}
         <AssetPreview asset={asset} />
         
         {/* Fee selector */}
         <FeeSelectorWithEstimate onFeeChange={setFeeRate} />
         
         {/* Cost breakdown */}
         {costEstimate && (
           <CostBreakdown
             costSats={costEstimate.costSats}
             costBTC={costEstimate.costBTC}
             feeRate={costEstimate.feeRate}
             estimatedVBytes={costEstimate.estimatedVBytes}
           />
         )}
         
         {/* Warning about permanence */}
         <Alert variant="warning">
           ⚠️ <strong>This action is permanent and irreversible.</strong>
           <br />
           Once inscribed, the asset will be permanently recorded on the Bitcoin blockchain.
         </Alert>
         
         {/* Confirmation checkbox */}
         <Checkbox 
           checked={confirmed}
           onChange={setConfirmed}
         >
           I understand this is permanent and will cost {costEstimate?.costSats} sats
         </Checkbox>
         
         {/* Action buttons */}
         <div className="modal-actions">
           <Button variant="ghost" onClick={onClose}>
             Cancel
           </Button>
           <Button 
             onClick={() => inscribeMutation.mutate()}
             disabled={!confirmed || inscribeMutation.isPending}
           >
             {inscribeMutation.isPending ? "Inscribing..." : "Inscribe on Bitcoin"}
           </Button>
         </div>
         
         {/* Progress indicator */}
         {inscribeMutation.isPending && (
           <Progress>
             <ProgressStep completed>Creating inscription manifest</ProgressStep>
             <ProgressStep current>Broadcasting commit transaction</ProgressStep>
             <ProgressStep>Broadcasting reveal transaction</ProgressStep>
             <ProgressStep>Confirming on blockchain</ProgressStep>
           </Progress>
         )}
       </Modal>
     );
   }
   ```

5. Cost breakdown component:
   ```tsx
   export function CostBreakdown({ costSats, costBTC, feeRate, estimatedVBytes }) {
     // Fetch BTC/USD rate
     const { data: btcPrice } = useQuery({
       queryKey: ["btc-price"],
       queryFn: async () => {
         const res = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
         const data = await res.json();
         return parseFloat(data.data.amount);
       }
     });
     
     const costUSD = btcPrice ? (costBTC * btcPrice).toFixed(2) : '...';
     
     return (
       <div className="cost-breakdown">
         <h3>Cost Breakdown</h3>
         <table>
           <tr>
             <td>Fee Rate:</td>
             <td>{feeRate} sat/vB</td>
           </tr>
           <tr>
             <td>Estimated Size:</td>
             <td>{estimatedVBytes} vBytes</td>
           </tr>
           <tr>
             <td>Total Cost:</td>
             <td>
               <strong>{costSats} sats</strong>
               <br />
               {costBTC} BTC
               <br />
               ~${costUSD} USD
             </td>
           </tr>
         </table>
       </div>
     );
   }
   ```

6. Success/tracking component:
   After inscription succeeds, show:
   - Inscription ID (copyable)
   - Transaction ID (copyable)
   - Link to mempool.space explorer
   - Estimated confirmation time
   - Status: "Pending" → "Confirmed"

7. Add route and navigation:
   - Route: /inscribe
   - Add to header navigation
   - Add to dashboard quick actions

Files to create:
- apps/originals-explorer/client/src/pages/inscribe-asset.tsx
- apps/originals-explorer/client/src/components/InscribeAssetModal.tsx
- apps/originals-explorer/client/src/components/FeeSelectorWithEstimate.tsx
- apps/originals-explorer/client/src/components/CostBreakdown.tsx

Files to modify:
- apps/originals-explorer/client/src/App.tsx (add route)
- apps/originals-explorer/client/src/components/layout/header.tsx (add nav)

Testing:
- Test fee selector updates correctly
- Test cost calculation
- Test confirmation flow
- Test inscription success
- Test error handling (insufficient funds, etc.)
- Verify transaction appears on explorer

Success criteria:
- Clear cost presentation
- Strong confirmation UX
- Progress indication during inscription
- Success state shows transaction details
- Error handling informative
- Links to explorer work
```

**Expected Output**:
- inscribe-asset.tsx page
- InscribeAssetModal component
- FeeSelectorWithEstimate component
- CostBreakdown component
- Routes and navigation
- Progress indicators
- Tests

---

## 🔄 Phase 4: Transfer & Polish (Week 3)

### Task BE-04: Ownership Transfer Endpoint
**Agent**: Backend Agent #2  
**Priority**: 🟢 Low  
**Estimated Time**: 3 hours  
**Dependencies**: BE-03

**Prompt**:
```
Implement ownership transfer endpoint for Bitcoin-inscribed assets.

Context:
- SDK method: originalsSdk.lifecycle.transferOwnership(asset, recipientAddress)
- Only assets in did:btco layer can be transferred
- Transfer sends inscription to new Bitcoin address

Requirements:

1. Create endpoint: POST /api/assets/:id/transfer
   Location: apps/originals-explorer/server/routes.ts
   
   Request body:
   {
     recipientAddress: string // Bitcoin address
   }

2. Implementation:
   ```typescript
   app.post("/api/assets/:id/transfer", authenticateUser, async (req, res) => {
     const { id } = req.params;
     const { recipientAddress } = req.body;
     
     try {
       // 1. Fetch asset
       const dbAsset = await storage.getAsset(id);
       if (!dbAsset) {
         return res.status(404).json({ error: "Asset not found" });
       }
       
       // 2. Verify ownership
       if (dbAsset.userId !== user.id) {
         return res.status(403).json({ error: "Forbidden" });
       }
       
       // 3. Verify asset is inscribed
       if (dbAsset.currentLayer !== 'did:btco') {
         return res.status(400).json({ 
           error: "Only inscribed assets can be transferred" 
         });
       }
       
       // 4. Validate recipient address
       if (!isValidBitcoinAddress(recipientAddress)) {
         return res.status(400).json({ 
           error: "Invalid Bitcoin address" 
         });
       }
       
       // 5. Reconstruct asset
       const originalsAsset = reconstructAssetFromDB(dbAsset);
       
       // 6. Transfer ownership
       const transferTx = await originalsSdk.lifecycle.transferOwnership(
         originalsAsset,
         recipientAddress
       );
       
       // 7. Update provenance
       const provenance = originalsAsset.getProvenance();
       
       // 8. Update database
       await storage.updateAsset(id, {
         provenance,
         metadata: {
           ...dbAsset.metadata,
           lastTransfer: {
             to: recipientAddress,
             txid: transferTx.txid,
             timestamp: new Date().toISOString()
           }
         }
       });
       
       // 9. Return success
       res.json({
         success: true,
         transfer: {
           txid: transferTx.txid,
           to: recipientAddress,
           explorerUrl: `https://mempool.space/tx/${transferTx.txid}`
         }
       });
       
     } catch (error) {
       console.error("Error transferring asset:", error);
       res.status(500).json({ 
         error: "Failed to transfer asset",
         message: error.message 
       });
     }
   });
   ```

3. Helper function for address validation:
   ```typescript
   import { validateBitcoinAddress } from '@originals/sdk/utils/bitcoin-address';
   
   function isValidBitcoinAddress(address: string): boolean {
     try {
       validateBitcoinAddress(address, process.env.BITCOIN_NETWORK);
       return true;
     } catch {
       return false;
     }
   }
   ```

Files to modify:
- apps/originals-explorer/server/routes.ts

Testing:
- Test successful transfer
- Test invalid address error
- Test non-inscribed asset error
- Test unauthorized access
- Verify transaction on explorer
- Verify provenance updated

Success criteria:
- Transfer completes successfully
- Transaction broadcasted
- Provenance records transfer
- Database updated
```

**Expected Output**:
- `/api/assets/:id/transfer` endpoint
- Address validation
- Error handling
- Tests

---

### Task FE-05: Transfer UI
**Agent**: Frontend Agent #1  
**Priority**: 🟢 Low  
**Estimated Time**: 4 hours  
**Dependencies**: BE-04

**Prompt**:
```
Create UI for transferring ownership of inscribed assets.

Context:
- Only did:btco assets can be transferred
- Need clear indication of ownership change
- Transfer is permanent and irreversible

Requirements:

1. Create transfer page:
   Location: apps/originals-explorer/client/src/pages/transfer-asset.tsx
   
   - Show only did:btco assets
   - Transfer button on each asset
   - Transfer modal for confirmation

2. Transfer modal:
   Component: TransferAssetModal
   
   ```tsx
   export function TransferAssetModal({ asset, isOpen, onClose }) {
     const [recipientAddress, setRecipientAddress] = useState('');
     const [confirmed, setConfirmed] = useState(false);
     
     const transferMutation = useMutation({
       mutationFn: async () => {
         return apiRequest(
           "POST",
           `/api/assets/${asset.id}/transfer`,
           { recipientAddress }
         );
       },
       onSuccess: (data) => {
         toast({
           title: "Transfer Successful",
           description: `Asset transferred to ${recipientAddress}`
         });
         onClose();
       }
     });
     
     return (
       <Modal isOpen={isOpen} onClose={onClose}>
         <h2>Transfer Ownership</h2>
         
         <AssetPreview asset={asset} />
         
         <FormField label="Recipient Bitcoin Address">
           <Input
             placeholder="bc1q..."
             value={recipientAddress}
             onChange={e => setRecipientAddress(e.target.value)}
           />
         </FormField>
         
         <Alert variant="warning">
           This will permanently transfer ownership to the recipient address.
         </Alert>
         
         <Checkbox checked={confirmed} onChange={setConfirmed}>
           I confirm I want to transfer this asset
         </Checkbox>
         
         <Button 
           onClick={() => transferMutation.mutate()}
           disabled={!recipientAddress || !confirmed}
         >
           Transfer
         </Button>
       </Modal>
     );
   }
   ```

3. Add route and navigation

Files to create:
- apps/originals-explorer/client/src/pages/transfer-asset.tsx
- apps/originals-explorer/client/src/components/TransferAssetModal.tsx

Success criteria:
- Transfer UI is clear and safe
- Address validation works
- Confirmation prevents accidents
- Success state clear
```

**Expected Output**:
- transfer-asset.tsx page
- TransferAssetModal component
- Routes
- Tests

---

### Task FE-06: Provenance Timeline Component
**Agent**: Frontend Agent #2  
**Priority**: 🟡 Medium  
**Estimated Time**: 4 hours  
**Dependencies**: FE-01, FE-03, FE-04

**Prompt**:
```
Create comprehensive provenance visualization showing asset lifecycle.

Context:
- Assets track complete history through layers
- Migrations, transfers, transactions all recorded
- Need visual timeline for users

Requirements:

1. Create timeline component:
   Location: apps/originals-explorer/client/src/components/ProvenanceTimeline.tsx
   
   ```tsx
   interface ProvenanceTimelineProps {
     provenance: {
       createdAt: string;
       creator: string;
       migrations: Array<{
         from: string;
         to: string;
         timestamp: string;
         transactionId?: string;
         inscriptionId?: string;
       }>;
       transfers: Array<{
         from: string;
         to: string;
         timestamp: string;
         transactionId: string;
       }>;
     };
   }
   
   export function ProvenanceTimeline({ provenance }: ProvenanceTimelineProps) {
     // Combine and sort all events chronologically
     const events = [
       {
         type: 'created',
         timestamp: provenance.createdAt,
         data: { creator: provenance.creator }
       },
       ...provenance.migrations.map(m => ({
         type: 'migration',
         timestamp: m.timestamp,
         data: m
       })),
       ...provenance.transfers.map(t => ({
         type: 'transfer',
         timestamp: t.timestamp,
         data: t
       }))
     ].sort((a, b) => 
       new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
     );
     
     return (
       <div className="provenance-timeline">
         {events.map((event, i) => (
           <TimelineEvent key={i} event={event} />
         ))}
       </div>
     );
   }
   ```

2. Timeline event component:
   ```tsx
   function TimelineEvent({ event }) {
     const getEventDetails = () => {
       switch (event.type) {
         case 'created':
           return {
             icon: '✨',
             title: 'Asset Created',
             description: `Created with identifier ${event.data.creator}`,
             color: 'gray'
           };
         case 'migration':
           return {
             icon: '🚀',
             title: `Migrated to ${event.data.to}`,
             description: event.data.transactionId 
               ? `Transaction: ${event.data.transactionId}`
               : 'Published to web',
             color: event.data.to === 'did:btco' ? 'orange' : 'blue'
           };
         case 'transfer':
           return {
             icon: '💸',
             title: 'Ownership Transferred',
             description: `To: ${event.data.to}`,
             color: 'green'
           };
       }
     };
     
     const details = getEventDetails();
     
     return (
       <div className="timeline-event">
         <div className="timeline-marker" style={{ background: details.color }}>
           {details.icon}
         </div>
         <div className="timeline-content">
           <h4>{details.title}</h4>
           <p>{details.description}</p>
           <time>{formatDate(event.timestamp)}</time>
         </div>
       </div>
     );
   }
   ```

3. Add to asset detail page:
   - Show timeline below asset info
   - Expandable by default
   - Export provenance as JSON option

4. Styling:
   - Vertical timeline with connecting line
   - Color-coded by event type
   - Icons for visual identification
   - Responsive design

Files to create:
- apps/originals-explorer/client/src/components/ProvenanceTimeline.tsx
- apps/originals-explorer/client/src/components/TimelineEvent.tsx
- Styles for timeline

Testing:
- Test with peer-only asset
- Test with published asset
- Test with inscribed asset
- Test with transfers
- Verify chronological order

Success criteria:
- Timeline displays all events
- Events sorted correctly
- Visual design clear
- Export works
```

**Expected Output**:
- ProvenanceTimeline component
- TimelineEvent component
- Styles
- Integration with detail page
- Tests

---

## 🧪 Phase 5: Testing & Integration (Week 3)

### Task TEST-04: Complete Integration Tests
**Agent**: Testing Agent  
**Priority**: 🔴 Critical  
**Estimated Time**: 6 hours  
**Dependencies**: All backend and frontend tasks

**Prompt**:
```
Create comprehensive integration tests for the complete asset lifecycle.

Context:
- All endpoints implemented
- All UI components completed
- Need to verify end-to-end flows

Requirements:

1. API Integration Tests:
   Location: apps/originals-explorer/server/__tests__/complete-lifecycle.test.ts
   
   Test suite:
   ```typescript
   describe('Complete Asset Lifecycle', () => {
     let testUser;
     let testAsset;
     
     beforeAll(async () => {
       // Setup test database
       // Create test user
       // Configure test SDK with mock providers
     });
     
     test('creates asset with did:peer', async () => {
       const response = await request(app)
         .post('/api/assets/create-with-did')
         .set('Authorization', `Bearer ${testUser.token}`)
         .send({
           title: 'Test Asset',
           category: 'test',
           mediaFile: { content: 'test', contentType: 'text/plain' }
         });
       
       expect(response.status).toBe(201);
       expect(response.body.didPeer).toMatch(/^did:peer:/);
       expect(response.body.currentLayer).toBe('did:peer');
       
       testAsset = response.body;
     });
     
     test('publishes asset to did:webvh', async () => {
       const response = await request(app)
         .post(`/api/assets/${testAsset.id}/publish-to-web`)
         .set('Authorization', `Bearer ${testUser.token}`)
         .send({ domain: 'test.example.com' });
       
       expect(response.status).toBe(200);
       expect(response.body.currentLayer).toBe('did:webvh');
       expect(response.body.didWebvh).toMatch(/^did:webvh:/);
     });
     
     test('inscribes asset on Bitcoin', async () => {
       const response = await request(app)
         .post(`/api/assets/${testAsset.id}/inscribe-on-bitcoin`)
         .set('Authorization', `Bearer ${testUser.token}`)
         .send({ feeRate: 7 });
       
       expect(response.status).toBe(200);
       expect(response.body.currentLayer).toBe('did:btco');
       expect(response.body.didBtco).toMatch(/^did:btco:/);
       expect(response.body.inscription).toBeDefined();
     });
     
     test('transfers ownership', async () => {
       const response = await request(app)
         .post(`/api/assets/${testAsset.id}/transfer`)
         .set('Authorization', `Bearer ${testUser.token}`)
         .send({ recipientAddress: 'bc1q...' });
       
       expect(response.status).toBe(200);
       expect(response.body.transfer.txid).toBeDefined();
     });
     
     test('verifies complete provenance chain', async () => {
       const response = await request(app)
         .get(`/api/assets/${testAsset.id}`)
         .set('Authorization', `Bearer ${testUser.token}`);
       
       const { provenance } = response.body;
       expect(provenance.migrations).toHaveLength(2);
       expect(provenance.transfers).toHaveLength(1);
     });
   });
   ```

2. Frontend E2E Tests:
   Location: apps/originals-explorer/e2e/complete-lifecycle.spec.ts
   
   Using Playwright:
   ```typescript
   test.describe('Complete Asset Lifecycle', () => {
     test('user creates, publishes, inscribes, and transfers asset', async ({ page }) => {
       // Login
       await page.goto('/login');
       await page.click('[data-testid="privy-login"]');
       
       // Create asset
       await page.goto('/create');
       await page.fill('[data-testid="asset-title"]', 'E2E Test Asset');
       await page.fill('[data-testid="asset-category"]', 'test');
       await page.click('[data-testid="submit-button"]');
       await expect(page.locator('text=Asset Created')).toBeVisible();
       
       // Publish to web
       await page.goto('/publish');
       await page.click('[data-testid="publish-button"]').first();
       await page.fill('[data-testid="domain-input"]', 'test.example.com');
       await page.click('[data-testid="confirm-publish"]');
       await expect(page.locator('text=Published Successfully')).toBeVisible();
       
       // Inscribe on Bitcoin
       await page.goto('/inscribe');
       await page.click('[data-testid="inscribe-button"]').first();
       await page.check('[data-testid="confirm-checkbox"]');
       await page.click('[data-testid="confirm-inscribe"]');
       await expect(page.locator('text=Inscribed on Bitcoin')).toBeVisible();
       
       // Transfer
       await page.goto('/transfer');
       await page.click('[data-testid="transfer-button"]').first();
       await page.fill('[data-testid="recipient-address"]', 'bc1q...');
       await page.check('[data-testid="confirm-transfer"]');
       await page.click('[data-testid="confirm-transfer-button"]');
       await expect(page.locator('text=Transfer Successful')).toBeVisible();
     });
   });
   ```

3. Error scenario tests:
   - Unauthorized access
   - Invalid data
   - Network failures
   - SDK errors
   - Already migrated errors

4. Performance tests:
   - Large asset creation
   - Multiple assets operations
   - Concurrent requests

Files to create:
- apps/originals-explorer/server/__tests__/complete-lifecycle.test.ts
- apps/originals-explorer/e2e/complete-lifecycle.spec.ts
- apps/originals-explorer/e2e/error-scenarios.spec.ts

Success criteria:
- All integration tests pass
- E2E tests cover happy path
- Error scenarios tested
- Tests run in CI
- Coverage >80%
```

**Expected Output**:
- API integration tests
- E2E tests
- Error scenario tests
- Test utilities
- CI configuration

---

## 🎯 Final Coordination Task

### Task COORD-01: Integration, Validation & Documentation
**Agent**: Coordinator Agent  
**Priority**: 🔴 Critical  
**Estimated Time**: 8 hours  
**Dependencies**: All tasks

**Prompt**:
```
Coordinate final integration, perform system validation, and create documentation.

Context:
- All components implemented
- Need to verify everything works together
- Need comprehensive documentation

Requirements:

1. Integration Verification:
   
   Create integration checklist:
   Location: INTEGRATION_CHECKLIST.md
   
   Verify:
   - [ ] All API endpoints respond correctly
   - [ ] Frontend pages load without errors
   - [ ] Authentication works end-to-end
   - [ ] Database migrations applied
   - [ ] Storage adapter configured
   - [ ] Bitcoin provider configured
   - [ ] SDK integration working
   - [ ] All tests passing
   
2. End-to-End System Test:
   
   Manually execute complete flow:
   - Create test user account
   - Create asset with did:peer
   - Verify DID in database
   - Publish to web layer
   - Verify resources in S3/storage
   - Inscribe on Bitcoin (signet)
   - Verify transaction on explorer
   - Transfer to test address
   - Verify complete provenance

3. Performance Validation:
   
   Measure and document:
   - Asset creation time (<5s)
   - Web publication time (<30s)
   - Bitcoin inscription time (~10min)
   - Page load times (<2s)
   - API response times (<500ms)

4. Documentation:
   
   Create user guides:
   - USER_GUIDE.md: Complete walkthrough
   - API_REFERENCE.md: All endpoints documented
   - DEPLOYMENT.md: Production setup guide
   - TROUBLESHOOTING.md: Common issues
   
   Update README:
   - Add getting started guide
   - Link to all documentation
   - Add screenshots
   - Add architecture diagram

5. Code Quality:
   
   Run linters and formatters:
   - ESLint
   - Prettier
   - TypeScript strict mode
   - Fix all warnings
   
   Review and improve:
   - Error handling
   - Loading states
   - Edge cases
   - User feedback

6. Security Review:
   
   Verify:
   - Authentication on all endpoints
   - Input validation
   - SQL injection prevention
   - XSS prevention
   - CSRF protection
   - Secure credential storage
   - Rate limiting
   - CORS configuration

7. Deployment Preparation:
   
   Create:
   - docker-compose.yml for local dev
   - .env.production.example
   - CI/CD pipeline config
   - Deployment scripts
   - Database backup scripts
   - Monitoring setup

8. Final Report:
   
   Create: IMPLEMENTATION_REPORT.md
   
   Include:
   - What was implemented
   - What was tested
   - Known issues/limitations
   - Performance metrics
   - Security considerations
   - Deployment requirements
   - Next steps/future work

Files to create:
- INTEGRATION_CHECKLIST.md
- USER_GUIDE.md
- API_REFERENCE.md
- DEPLOYMENT.md
- TROUBLESHOOTING.md
- IMPLEMENTATION_REPORT.md
- docker-compose.yml
- .github/workflows/ci.yml (if using GitHub Actions)

Files to update:
- README.md
- .env.example
- package.json scripts

Success criteria:
- Complete system verified working
- All documentation complete
- Deployment ready
- Security reviewed
- Performance acceptable
- Code quality high
```

**Expected Output**:
- Integration verification complete
- All documentation created
- Deployment artifacts
- Implementation report
- Production-ready system

---

## 📊 Progress Tracking

### Task Status Template

For the coordinator agent to track progress, use this template:

```yaml
tasks:
  DB-01:
    status: completed | in_progress | blocked | pending
    assignee: Agent Name
    started: 2025-10-04
    completed: 2025-10-04
    notes: Any relevant notes
    
  BE-01:
    status: pending
    assignee: Backend Agent #1
    dependencies: [DB-01]
    blocked_by: null
    
  # ... etc for all tasks
```

### Daily Standup Format

Each agent reports:
1. What I completed yesterday
2. What I'm working on today
3. Any blockers or questions
4. Estimated completion

---

## 🚨 Escalation Protocol

### When an Agent Gets Blocked

If an agent encounters a blocker:

1. **Try to self-resolve** (15 min)
   - Read documentation
   - Check existing code
   - Search for similar patterns

2. **Ask Coordinator** (if still blocked)
   - Describe the problem
   - What you've tried
   - Specific help needed

3. **Coordinator Actions**:
   - Can reassign task
   - Can adjust scope
   - Can provide additional context
   - Can escalate to human

### Common Blockers & Solutions

**"I don't understand the SDK interface"**
→ Read: src/lifecycle/LifecycleManager.ts and tests/integration/CompleteLifecycle.e2e.test.ts

**"Tests are failing"**
→ Run tests individually, check for missing dependencies, verify test database

**"Frontend build errors"**
→ Check imports, verify types, run `bun install`

**"Can't connect to Bitcoin provider"**
→ Check env vars, verify service running, check network connectivity

---

## 📋 Agent Prompt Template

When assigning a task to an agent, use this format:

```
TASK: [Task ID and Name]
PRIORITY: [🔴 Critical | 🟡 Medium | 🟢 Low]
ESTIMATED TIME: [X hours]
DEPENDENCIES: [List of task IDs]

CONTEXT:
[Brief background on why this task exists]

REQUIREMENTS:
[Detailed list of what needs to be done]

FILES TO CREATE/MODIFY:
[List of file paths]

SUCCESS CRITERIA:
[How to know the task is complete]

TESTING:
[How to verify the implementation works]

ADDITIONAL RESOURCES:
[Links to relevant documentation or examples]
```

---

## 🎓 Agent Onboarding

### For New Agents Joining Mid-Project

Read in this order:
1. ASSET_MIGRATION_STATUS.md - Understand what we're building
2. MIGRATION_FLOW_DIAGRAM.md - Visual architecture
3. This document (AI_AGENT_COORDINATION_PLAN.md) - Your tasks
4. Check Progress Tracking to see current status

### Key Codebase Locations

- **SDK Core**: `src/lifecycle/`
- **API Backend**: `apps/originals-explorer/server/`
- **Frontend**: `apps/originals-explorer/client/src/`
- **Tests**: `tests/` and `apps/originals-explorer/__tests__/`
- **Database**: `apps/originals-explorer/migrations/`

---

## 🎯 Success Metrics

By the end of implementation, we should have:

- [ ] 15+ new API endpoints
- [ ] 10+ new UI pages/components
- [ ] 100+ integration tests
- [ ] 5+ E2E tests
- [ ] Complete documentation
- [ ] Production-ready deployment
- [ ] <2s page load times
- [ ] <500ms API response times
- [ ] 90%+ test coverage

---

## 🚀 Let's Build!

This plan enables parallel work across multiple AI agents. Start with Phase 1 tasks, which can begin immediately. Phase 2 and 3 have some parallel opportunities (storage adapter and Bitcoin provider can be done simultaneously).

**Coordinator Agent**: Begin by assigning Phase 1 tasks and setting up progress tracking.

**Individual Agents**: Read your assigned task prompt carefully, follow the requirements exactly, and communicate blockers immediately.

**Success depends on**: Clear communication, following the specifications, comprehensive testing, and thorough documentation.

Let's create a production-ready asset management system! 🎉
