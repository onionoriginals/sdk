# Quick Start: AI Agent Prompts - Copy & Paste Ready

This document contains ready-to-use prompts for coordinating AI agents. Copy and paste these into your AI agent interface (Claude, Cursor, GitHub Copilot, etc.)

---

## 🚀 Getting Started

### Step 1: Assign Coordinator Agent

**Copy this prompt:**

```
You are the Coordinator Agent for the Originals Protocol asset migration implementation.

Your responsibilities:
1. Track progress of all tasks in AI_AGENT_COORDINATION_PLAN.md
2. Assign tasks to available agents
3. Resolve blockers
4. Ensure integration between components
5. Verify completion criteria

First, create a progress tracking file: TASK_PROGRESS.yaml

Use this format:
```yaml
start_date: 2025-10-04
target_completion: 2025-10-25
status: in_progress

phases:
  phase_1_foundation:
    status: in_progress
    tasks:
      DB-01:
        name: Database Schema Migration
        status: pending
        assignee: null
        priority: critical
        estimated_hours: 2
        dependencies: []
      BE-01:
        name: Asset Creation with SDK Integration
        status: pending
        assignee: null
        priority: critical
        estimated_hours: 6
        dependencies: [DB-01]
      # ... etc
```

After creating the tracking file, report:
1. Total tasks to complete
2. Critical path tasks
3. Suggested agent assignments
4. Estimated total time

Then ask: "Which agents are available to begin work?"
```

---

## 📋 Phase 1: Foundation Tasks (Week 1)

### Task DB-01: Database Schema Migration

**Agent Type:** Database Agent  
**Copy this prompt:**

```
TASK: DB-01 - Database Schema Migration
PRIORITY: 🔴 Critical
ESTIMATED TIME: 2 hours
DEPENDENCIES: None

You are implementing database schema changes to support asset lifecycle tracking.

CONTEXT:
The Originals Protocol has three layers (did:peer, did:webvh, did:btco). We need to track which layer each asset is in, store DID identifiers for each layer, and maintain provenance history.

CURRENT STATE:
- Database: PostgreSQL with Drizzle ORM
- Schema location: apps/originals-explorer/shared/schema.ts
- Migrations location: apps/originals-explorer/migrations/

REQUIREMENTS:

1. Create migration file: apps/originals-explorer/migrations/0002_add_layer_tracking.sql

Add these columns to assets table:
- current_layer TEXT DEFAULT 'did:peer'
- did_peer TEXT
- did_webvh TEXT
- did_btco TEXT
- provenance JSONB

Create indexes:
- CREATE INDEX idx_assets_current_layer ON assets(current_layer);
- CREATE INDEX idx_assets_did_peer ON assets(did_peer);
- CREATE INDEX idx_assets_did_btco ON assets(did_btco);

2. Update schema.ts:
Add the new columns to the assets table definition.

3. Update storage.ts:
Modify these functions to handle new fields:
- createAsset() - Store layer and DIDs
- updateAsset() - Update layer and provenance
- getAssetsByUserId() - Add optional layer filter parameter

TESTING:
1. Run migration: bun run drizzle-kit push
2. Verify columns exist in database
3. Test inserting asset with new fields
4. Test querying by layer

SUCCESS CRITERIA:
- Migration runs without errors
- Schema exports correct TypeScript types
- Storage functions accept and return new fields
- Queries by layer work correctly

FILES TO MODIFY:
- apps/originals-explorer/migrations/0002_add_layer_tracking.sql (create new)
- apps/originals-explorer/shared/schema.ts
- apps/originals-explorer/server/storage.ts

Start by examining the existing schema, then create the migration file. Show me your migration SQL before applying it.
```

---

### Task BE-01: Asset Creation Backend

**Agent Type:** Backend Agent  
**Copy this prompt:**

```
TASK: BE-01 - Asset Creation with SDK Integration
PRIORITY: 🔴 Critical
ESTIMATED TIME: 6 hours
DEPENDENCIES: DB-01 (must be completed first)

You are implementing proper SDK integration for asset creation.

PROBLEM:
The current POST /api/assets endpoint creates database records but doesn't use the Originals SDK to create DID identifiers. Assets end up without cryptographic identity.

SOLUTION:
Create new endpoint that uses originalsSdk.lifecycle.createAsset() to generate proper did:peer identifiers with DID documents.

CONTEXT:
- SDK is configured at: apps/originals-explorer/server/originals.ts
- Current broken endpoint: POST /api/assets in routes.ts
- SDK method signature: createAsset(resources: AssetResource[]): Promise<OriginalsAsset>

REQUIREMENTS:

1. Create endpoint: POST /api/assets/create-with-did
   Location: apps/originals-explorer/server/routes.ts
   
   Request body:
   {
     title: string,
     description?: string,
     category: string,
     tags?: string[],
     mediaFile?: { content: string, contentType: string },
     customProperties?: Record<string, any>
   }

2. Implementation steps:
   a) Hash media file content using SHA-256
   b) Create AssetResource array with id, type, contentType, hash, content
   c) Call: const asset = await originalsSdk.lifecycle.createAsset(resources)
   d) Extract: DID document, DID ID, provenance
   e) Store in database with new layer tracking fields
   f) Return complete asset including DID

3. Helper functions to create:
   - hashContent(content: string | Buffer): string
   - createAssetResources(mediaFile, metadata): AssetResource[]
   - reconstructAssetFromDB(dbAsset): OriginalsAsset

EXISTING CODE TO REFERENCE:
- tests/integration/CompleteLifecycle.e2e.test.ts (lines 116-149) - Shows SDK usage
- apps/originals-explorer/server/routes.ts (lines 434-477) - Shows similar pattern in spreadsheet upload

ERROR HANDLING:
- Validate all required fields
- Handle SDK errors with descriptive messages
- Return proper HTTP status codes

TESTING:
Test with curl:
```bash
curl -X POST http://localhost:5000/api/assets/create-with-did \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test Asset",
    "category": "test",
    "mediaFile": {
      "content": "test content",
      "contentType": "text/plain"
    }
  }'
```

Verify response includes:
- didPeer: "did:peer:..."
- currentLayer: "did:peer"
- provenance: { createdAt, creator, migrations: [], transfers: [] }

SUCCESS CRITERIA:
- Endpoint returns asset with valid did:peer identifier
- DID document stored in database
- Provenance initialized correctly
- Resources have valid hashes

Start by reading the existing spreadsheet upload code (routes.ts lines 434-477) which already uses the SDK. Then implement the new endpoint following that pattern.
```

---

### Task FE-01: Asset Creation Frontend

**Agent Type:** Frontend Agent  
**Copy this prompt:**

```
TASK: FE-01 - Update Asset Creation UI
PRIORITY: 🔴 Critical
ESTIMATED TIME: 4 hours
DEPENDENCIES: BE-01 (backend endpoint must exist)

You are updating the frontend to call the new SDK-integrated backend endpoint.

PROBLEM:
The create-asset-simple.tsx form calls POST /api/assets which doesn't create proper DIDs. Need to update to use new endpoint and display the created DID identifier.

CONTEXT:
- Current file: apps/originals-explorer/client/src/pages/create-asset-simple.tsx
- New backend endpoint: POST /api/assets/create-with-did
- Response includes: { id, didPeer, currentLayer, provenance, ... }

REQUIREMENTS:

1. Update mutation (around line 94):
   Change endpoint from "/api/assets" to "/api/assets/create-with-did"

2. Update success handler (around line 103):
   Display the created DID identifier:
   ```typescript
   onSuccess: (data) => {
     toast({
       title: "Asset Created Successfully!",
       description: `Created with identifier: ${data.didPeer}`
     });
     // Show success modal or redirect
   }
   ```

3. Create success component:
   New file: apps/originals-explorer/client/src/components/AssetCreatedSuccess.tsx
   
   Should display:
   - ✅ Success message
   - DID identifier with copy button
   - Layer badge showing "did:peer"
   - Link to view asset details
   - "What's next?" section with options:
     * Publish to Web
     * Create another asset
     * View in dashboard

4. Update form to show loading state:
   - Disable form during submission
   - Show "Creating asset..." message
   - Show progress if possible

EXAMPLE SUCCESS COMPONENT:
```tsx
export function AssetCreatedSuccess({ asset }) {
  const [copied, setCopied] = useState(false);
  
  const copyDID = () => {
    navigator.clipboard.writeText(asset.didPeer);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  return (
    <div className="success-card">
      <h2>✅ Asset Created Successfully!</h2>
      
      <div className="did-display">
        <label>DID Identifier:</label>
        <code>{asset.didPeer}</code>
        <button onClick={copyDID}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      
      <LayerBadge layer="did:peer" />
      
      <div className="next-actions">
        <h3>What's next?</h3>
        <button onClick={() => navigate(`/assets/${asset.id}`)}>
          View Asset Details
        </button>
        <button onClick={() => navigate('/publish')}>
          Publish to Web
        </button>
      </div>
    </div>
  );
}
```

TESTING:
1. Fill form and submit
2. Verify "Creating asset..." shows
3. Verify success modal appears
4. Verify DID is displayed and copyable
5. Verify layer badge shows "did:peer"
6. Try copy button

SUCCESS CRITERIA:
- Form calls correct endpoint
- Success state displays DID clearly
- Copy button works
- User knows what to do next
- Error handling works

Start by reading the current create-asset-simple.tsx file to understand the structure, then make the necessary changes.
```

---

## 🌐 Phase 2: Web Publication Tasks (Week 1-2)

### Task INFRA-01: S3 Storage Adapter

**Agent Type:** Infrastructure Agent  
**Copy this prompt:**

```
TASK: INFRA-01 - Configure S3 Storage Adapter
PRIORITY: 🔴 Critical
ESTIMATED TIME: 4-6 hours
DEPENDENCIES: None (can work in parallel)

You are implementing AWS S3 storage for hosting asset resources.

CONTEXT:
- SDK uses StorageAdapter interface for publishing resources
- Current: MemoryStorageAdapter (ephemeral, lost on restart)
- Need: Persistent S3 storage for production

REQUIREMENTS:

1. Install dependencies:
   ```bash
   bun add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
   ```

2. Create S3StorageAdapter:
   Location: src/storage/S3StorageAdapter.ts
   
   Interface to implement:
   ```typescript
   export interface StorageAdapter {
     put(objectKey: string, data: Buffer, options?: { contentType?: string }): Promise<string>;
     get(objectKey: string): Promise<{ content: Buffer; contentType: string } | null>;
     delete(objectKey: string): Promise<boolean>;
   }
   ```

3. Implementation details:
   - Use S3Client from @aws-sdk/client-s3
   - put() should use PutObjectCommand
   - Return public URL (S3 or CloudFront)
   - Handle errors and implement retries
   - Support custom contentType metadata

4. Update SDK config:
   Location: apps/originals-explorer/server/originals.ts
   
   ```typescript
   import { S3StorageAdapter } from '@originals/sdk/storage/S3StorageAdapter';
   
   const storageAdapter = process.env.NODE_ENV === 'production'
     ? new S3StorageAdapter({
         bucket: process.env.S3_BUCKET!,
         region: process.env.S3_REGION!,
         cloudfrontDomain: process.env.CLOUDFRONT_DOMAIN
       })
     : new MemoryStorageAdapter();
   
   export const originalsSdk = OriginalsSDK.create({
     // ... existing config
     storageAdapter
   });
   ```

5. Environment variables (.env.example):
   ```
   S3_BUCKET=originals-resources-dev
   S3_REGION=us-east-1
   AWS_ACCESS_KEY_ID=your_key_here
   AWS_SECRET_ACCESS_KEY=your_secret_here
   CLOUDFRONT_DOMAIN=cdn.example.com
   ```

6. S3 Bucket setup script:
   Location: scripts/setup-s3-bucket.sh
   
   Should:
   - Create bucket with aws-cli
   - Enable public read for resources
   - Configure CORS
   - Output bucket URL

REFERENCE:
- See src/storage/MemoryStorageAdapter.ts for interface pattern

TESTING:
1. Unit test: Upload file, retrieve it, verify content matches
2. Integration: Run SDK publishToWeb(), verify file in S3
3. Manual: Check file is publicly accessible at returned URL

SUCCESS CRITERIA:
- S3StorageAdapter implements interface correctly
- Files upload successfully to S3
- Public URLs are accessible
- SDK can use adapter for publishing
- Environment variables documented

Start by examining MemoryStorageAdapter.ts to understand the interface, then create the S3 implementation.
```

---

### Task BE-02: Web Publication Endpoint

**Agent Type:** Backend Agent  
**Copy this prompt:**

```
TASK: BE-02 - Web Publication Endpoint
PRIORITY: 🔴 Critical
ESTIMATED TIME: 4 hours
DEPENDENCIES: INFRA-01 (S3 adapter), BE-01 (reconstruction helper)

You are implementing the web publication endpoint that migrates assets from did:peer to did:webvh.

CONTEXT:
- SDK method: originalsSdk.lifecycle.publishToWeb(asset, domain)
- Assets must be in did:peer layer to publish
- Publishing uploads resources to S3 and creates did:webvh binding

REQUIREMENTS:

1. Create endpoint: POST /api/assets/:id/publish-to-web
   Location: apps/originals-explorer/server/routes.ts
   
   Request body:
   ```json
   {
     "domain": "example.com"  // optional, use default if not provided
   }
   ```

2. Implementation flow:
   a) Fetch asset from database by ID
   b) Verify ownership (asset.userId === user.id)
   c) Verify asset is in did:peer layer (reject if already published)
   d) Reconstruct OriginalsAsset instance from database row
   e) Call SDK: await originalsSdk.lifecycle.publishToWeb(asset, domain)
   f) Extract updated data: provenance, did:webvh binding, resource URLs
   g) Update database with new layer, did:webvh, provenance
   h) Return success response

3. Helper function:
   ```typescript
   function reconstructAssetFromDB(dbAsset: any): OriginalsAsset {
     // Convert database row to OriginalsAsset instance
     // Include resources, DID document, credentials
     // Restore provenance state
     return originalsAsset;
   }
   ```

4. Error handling:
   - 404: Asset not found
   - 403: Not the owner
   - 400: Asset already in did:webvh or did:btco layer
   - 500: Storage adapter error (provide details)
   - 500: SDK error (provide details)

5. Response format:
   ```json
   {
     "success": true,
     "asset": {
       "id": "...",
       "currentLayer": "did:webvh",
       "didPeer": "did:peer:...",
       "didWebvh": "did:webvh:example.com:...",
       "provenance": {
         "migrations": [
           {
             "from": "did:peer",
             "to": "did:webvh",
             "timestamp": "2025-10-04T..."
           }
         ]
       }
     }
   }
   ```

REFERENCE:
- SDK usage: tests/integration/CompleteLifecycle.e2e.test.ts lines 151-199
- Similar pattern: routes.ts spreadsheet upload (lines 434-477)

TESTING:
```bash
# After creating asset, get its ID and publish:
curl -X POST http://localhost:5000/api/assets/ASSET_ID/publish-to-web \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"domain": "test.example.com"}'
```

Verify:
- Response has didWebvh
- Database updated with new layer
- Resources uploaded to S3 (check S3 console)
- Resource URLs in response are accessible

SUCCESS CRITERIA:
- Endpoint successfully publishes asset
- Resources uploaded and accessible via HTTPS
- did:webvh created and stored
- Provenance updated with migration record
- Database reflects new state
- Cannot publish already-published asset

Start by reading the CompleteLifecycle.e2e.test.ts to see how the SDK is used, then implement the endpoint.
```

---

## ⛓️ Phase 3: Bitcoin Inscription (Week 2)

### Task INFRA-02: Bitcoin Provider Setup

**Agent Type:** Infrastructure Agent  
**Copy this prompt:**

```
TASK: INFRA-02 - Configure Bitcoin Ordinals Provider
PRIORITY: 🟡 Medium
ESTIMATED TIME: 8-12 hours
DEPENDENCIES: None (can work in parallel)

You are setting up Bitcoin integration for inscriptions. Choose self-hosted or service.

DECISION REQUIRED: Self-hosted Ord vs Third-party service

For TESTING/DEVELOPMENT: Use self-hosted on Bitcoin Signet (recommended)
For PRODUCTION: Evaluate both options

OPTION A: SELF-HOSTED ORD (Recommended for learning/control)
==============================================================

Step 1: Set up Bitcoin Core on Signet
```bash
# Install Bitcoin Core (v24.0+)
# Create bitcoin.conf:
cat > ~/.bitcoin/bitcoin.conf << EOF
server=1
rpcuser=originals
rpcpassword=$(openssl rand -hex 32)
rpcallowip=127.0.0.1
txindex=1
signet=1
EOF

# Start Bitcoin Core
bitcoind -daemon

# Wait for sync (signet is ~1GB, takes 1-2 hours)
bitcoin-cli -signet getblockchaininfo
```

Step 2: Install and configure Ord
```bash
# Install Ord
cargo install ord --locked
# OR download binary from https://github.com/ordinals/ord/releases

# Create ord.yaml
cat > ~/.ord/ord.yaml << EOF
bitcoin_rpc_url: http://localhost:38332  # Signet port
bitcoin_rpc_username: originals
bitcoin_rpc_password: YOUR_PASSWORD_FROM_BITCOIN_CONF
EOF

# Start ord server
ord --signet server &

# Verify
curl http://localhost:80/inscriptions
```

Step 3: Create and fund wallet
```bash
# Create wallet
ord --signet wallet create

# Get address
ord --signet wallet receive

# Get signet coins from faucet
# Visit: https://signetfaucet.com
# Send coins to your address

# Check balance
ord --signet wallet balance
```

Step 4: Configure SDK
Location: apps/originals-explorer/server/originals.ts

```typescript
import { OrdinalsClient } from '@originals/sdk';

const ordinalsProvider = process.env.NODE_ENV === 'test'
  ? new OrdMockProvider()
  : new OrdinalsClient({
      network: process.env.BITCOIN_NETWORK as any,
      apiUrl: process.env.ORD_API_URL || 'http://localhost:80',
      auth: {
        username: process.env.ORD_RPC_USER,
        password: process.env.ORD_RPC_PASSWORD
      }
    });

export const originalsSdk = OriginalsSDK.create({
  // ... existing config
  ordinalsProvider
});
```

Environment variables:
```env
BITCOIN_NETWORK=signet
ORD_API_URL=http://localhost:80
ORD_RPC_USER=originals
ORD_RPC_PASSWORD=your_password_here
```

OPTION B: THIRD-PARTY SERVICE (Faster setup)
==============================================

Research and choose provider:
- Hiro API: https://docs.hiro.so/ordinals
- Ordinals.com API
- Others

Implement service adapter if needed.

BOTH OPTIONS: Fee Estimation
==============================

Create: src/adapters/MempoolSpaceFeeOracle.ts

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

Update SDK config:
```typescript
feeOracle: new MempoolSpaceFeeOracle()
```

DOCUMENTATION:
Create: docs/BITCOIN_SETUP.md with step-by-step instructions

TESTING:
```bash
# Test inscription
curl -X POST http://localhost:80/inscribe \
  -H "Content-Type: application/json" \
  -d '{"content": "test inscription"}'

# Check mempool.space signet:
# https://mempool.space/signet/tx/YOUR_TX_ID
```

SUCCESS CRITERIA:
- Bitcoin provider configured and working
- Can create test inscriptions on signet
- Transactions visible on mempool.space
- Fee estimation returns reasonable values
- Documentation complete
- Secure credential management

Start with Option A (self-hosted on signet) for testing. Document the process as you go.
```

---

## 🎯 Specialized Agent Prompts

### Testing Agent Prompt

**Copy this for comprehensive testing:**

```
You are the Testing Agent. Your role is to create comprehensive tests for all implemented features.

CONTEXT:
Read these files to understand what's been implemented:
- apps/originals-explorer/server/routes.ts (API endpoints)
- apps/originals-explorer/client/src/pages/*.tsx (UI pages)
- tests/integration/CompleteLifecycle.e2e.test.ts (example tests)

YOUR TASKS:

1. Backend Integration Tests
   For each API endpoint, create tests covering:
   - Happy path (successful operation)
   - Authentication (401 for missing token)
   - Authorization (403 for wrong user)
   - Validation (400 for invalid input)
   - Not found (404 for missing resources)
   - Error handling (500 scenarios)

2. Frontend Component Tests
   For each UI component, test:
   - Rendering
   - User interactions
   - API calls (mocked)
   - Success states
   - Error states
   - Loading states

3. E2E Tests
   Test complete user flows:
   - User creates asset → sees success
   - User publishes asset → sees published state
   - User inscribes asset → sees inscription details
   - User transfers asset → sees confirmation

TEST FRAMEWORKS:
- Backend: Bun test
- Frontend: React Testing Library + Vitest
- E2E: Playwright (preferred) or Cypress

TEST STRUCTURE:
```typescript
describe('Feature Name', () => {
  beforeEach(() => {
    // Setup
  });
  
  test('should do X when Y', async () => {
    // Arrange
    // Act
    // Assert
  });
  
  test('should handle error when Z', async () => {
    // Test error case
  });
});
```

Start by examining existing tests, then create tests for new features. Aim for >80% coverage.
```

---

### Documentation Agent Prompt

**Copy this for documentation:**

```
You are the Documentation Agent. Your role is to create clear, comprehensive documentation.

DOCUMENTS TO CREATE:

1. USER_GUIDE.md
   - Getting started
   - Step-by-step walkthroughs for each feature
   - Screenshots or diagrams
   - Common workflows
   - Tips and best practices

2. API_REFERENCE.md
   - All endpoints documented
   - Request/response formats
   - Authentication requirements
   - Error codes
   - Example curl commands

3. DEPLOYMENT.md
   - Prerequisites
   - Environment variables
   - Database setup
   - S3 configuration
   - Bitcoin provider setup
   - Production checklist

4. TROUBLESHOOTING.md
   - Common errors and solutions
   - Debug procedures
   - Logs to check
   - Performance issues
   - Contact information

STYLE:
- Clear and concise
- Code examples for everything
- Real-world examples
- Assume user is technical but new to the project
- Include "Quick Start" sections
- Use diagrams where helpful

Start by reviewing the implemented features, then create documentation that would help a new developer or user get started quickly.
```

---

## 🔄 Coordination Workflow

### Daily Agent Sync (For Coordinator)

**Run this prompt each morning:**

```
You are coordinating the AI agent team. Run daily sync:

1. Review TASK_PROGRESS.yaml
2. Check which tasks are completed
3. Check which tasks are blocked
4. Assign new tasks to available agents
5. Update dependencies
6. Calculate estimated completion date

Report:
- Tasks completed yesterday: [list]
- Tasks in progress today: [list]
- Blocked tasks: [list with reasons]
- Tasks ready to start: [list]
- Critical path status: [on track / delayed]
- Estimated completion: [date]

Then provide instructions for today's work.
```

---

## 📊 Progress Check Prompt

**Use this to check overall progress:**

```
Generate a progress report for the Originals Protocol implementation.

Review all files in the project and determine:

1. COMPLETED TASKS:
   - List all implemented endpoints
   - List all completed UI pages
   - List all passing tests
   
2. IN PROGRESS:
   - What's being worked on now
   - Estimated completion time
   
3. NOT STARTED:
   - What still needs to be done
   - Estimated effort
   
4. BLOCKERS:
   - Technical blockers
   - Dependency blockers
   - Resource blockers
   
5. METRICS:
   - Test coverage percentage
   - Number of endpoints complete
   - Number of UI pages complete
   - Lines of code added
   
6. NEXT STEPS:
   - Top 3 priorities
   - Suggested task assignments
   - Risk areas

Format as a concise status report suitable for stakeholders.
```

---

## 🚨 Troubleshooting Common Issues

### Agent Reports: "I can't find the file"

**Coordinator response:**

```
The file path might be relative. Try these:
1. Check from workspace root: /workspace/[path]
2. Use Glob tool to search: **/*[filename]*
3. Use Grep to search for content: [search term]
4. Ask: "List all files in [directory]"
```

### Agent Reports: "Tests are failing"

**Coordinator response:**

```
Debug the test failures:
1. Run the specific test file
2. Check error messages
3. Verify dependencies installed
4. Check environment variables
5. Verify test database configured
6. Check if recent changes broke tests

If you need help, provide:
- Test file name
- Error message
- What you've tried
```

### Agent Reports: "SDK method not working"

**Coordinator response:**

```
Check SDK usage:
1. Read: tests/integration/CompleteLifecycle.e2e.test.ts
2. Verify SDK configured: apps/originals-explorer/server/originals.ts
3. Check parameters match interface
4. Verify dependencies initialized
5. Check for TypeScript errors

The SDK is proven to work (100% test coverage), so likely a usage issue.
```

---

## ✅ Completion Checklist

**Use this to verify implementation is complete:**

```
Verify the Originals Protocol implementation is complete:

BACKEND ENDPOINTS:
- [ ] POST /api/assets/create-with-did
- [ ] POST /api/assets/:id/publish-to-web
- [ ] POST /api/assets/:id/inscribe-on-bitcoin
- [ ] POST /api/assets/:id/transfer
- [ ] GET /api/bitcoin/fee-estimate
- [ ] POST /api/bitcoin/calculate-inscription-cost
- [ ] GET /api/assets (with layer filter)

FRONTEND PAGES:
- [ ] /create (with SDK integration)
- [ ] /publish (web publication)
- [ ] /inscribe (Bitcoin inscription)
- [ ] /transfer (ownership transfer)
- [ ] Dashboard (with layer filtering)

COMPONENTS:
- [ ] LayerBadge
- [ ] LayerFilter
- [ ] ProvenanceTimeline
- [ ] AssetCreatedSuccess
- [ ] PublishAssetModal
- [ ] InscribeAssetModal
- [ ] TransferAssetModal

INFRASTRUCTURE:
- [ ] S3 storage adapter configured
- [ ] Bitcoin provider configured (Ord or service)
- [ ] Fee oracle implemented
- [ ] Database migrations applied

TESTS:
- [ ] Backend integration tests
- [ ] Frontend component tests
- [ ] E2E tests for main flows
- [ ] Coverage >80%

DOCUMENTATION:
- [ ] USER_GUIDE.md
- [ ] API_REFERENCE.md
- [ ] DEPLOYMENT.md
- [ ] TROUBLESHOOTING.md
- [ ] README.md updated

DEPLOYMENT:
- [ ] Environment variables documented
- [ ] Docker compose file (optional)
- [ ] CI/CD pipeline
- [ ] Production checklist

For each incomplete item, create a task and assign to an agent.
```

---

## 🎓 Tips for Effective Agent Coordination

### For Coordinators:
1. **Start Small**: Begin with Phase 1, don't overwhelm agents
2. **Clear Dependencies**: Don't assign Task X if it depends on incomplete Task Y
3. **Parallel Work**: Maximize parallel tasks (storage + Bitcoin provider)
4. **Regular Sync**: Check progress daily
5. **Celebrate Wins**: Acknowledge completed tasks

### For Individual Agents:
1. **Read Context**: Always read the referenced files first
2. **Follow Pattern**: Look for similar code in the codebase
3. **Test First**: Make sure existing tests pass before changing code
4. **Ask Early**: Don't spend >30min blocked, ask coordinator
5. **Document**: Add comments explaining your code

### For Success:
1. **Communication**: Over-communicate progress and blockers
2. **Testing**: Test everything before marking complete
3. **Documentation**: Document as you build
4. **Code Quality**: Follow existing patterns and style
5. **Integration**: Verify your code works with other components

---

## 🚀 Ready to Start?

1. **Assign Coordinator**: Use first prompt in this document
2. **Coordinator creates**: TASK_PROGRESS.yaml file
3. **Coordinator assigns**: Phase 1 tasks (DB-01, BE-01, FE-01)
4. **Agents execute**: Copy relevant prompts and work
5. **Daily sync**: Coordinator runs progress check
6. **Iterate**: Continue through all phases

**The system is designed for success. Follow the prompts, communicate clearly, and build an amazing asset management system!** 🎉

---

*Created: 2025-10-04*  
*Companion to: AI_AGENT_COORDINATION_PLAN.md*
