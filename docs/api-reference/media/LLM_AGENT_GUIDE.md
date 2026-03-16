# Originals SDK - LLM Agent Reference Guide

> **Purpose**: This document provides LLM agents with comprehensive, structured information about the Originals SDK for accurate code generation and API usage.

## Related Documentation

- **[LLM_QUICK_REFERENCE.md](./LLM_QUICK_REFERENCE.md)** - Compact quick-reference card
- **[LLM_TYPE_REFERENCE.md](./LLM_TYPE_REFERENCE.md)** - Complete type definitions

## Quick Reference

```typescript
import { OriginalsSDK, OrdMockProvider } from '@originals/sdk';

// Create SDK instance (minimal)
const sdk = OriginalsSDK.create({ network: 'regtest' });

// Create with Bitcoin support (required for inscriptions)
const sdk = OriginalsSDK.create({
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  webvhNetwork: 'magby',
  ordinalsProvider: new OrdMockProvider(),
});
```

---

## Architecture Overview

### Three-Layer Asset Lifecycle

Assets migrate **unidirectionally** through three DID method layers:

```
did:peer → did:webvh → did:btco
   ↓           ↓          ↓
Private    Public     Immutable
Offline    HTTPS      Bitcoin
Free       Hosted     Permanent
```

| Layer | Method | Description | Use Case |
|-------|--------|-------------|----------|
| Layer 1 | `did:peer` | Private, offline creation | Draft/experimentation |
| Layer 2 | `did:webvh` | Public discovery via HTTPS | Publishing/sharing |
| Layer 3 | `did:btco` | Permanent on Bitcoin | Ownership transfer |

### Network Mapping

WebVH networks map to Bitcoin networks automatically:

| WebVH Network | Domain | Bitcoin Network | Stability |
|---------------|--------|-----------------|-----------|
| `magby` | magby.originals.build | `regtest` | Development (all versions) |
| `cleffa` | cleffa.originals.build | `signet` | Staging (minor releases) |
| `pichu` | pichu.originals.build | `mainnet` | Production (major releases) |

---

## SDK Entry Point

### OriginalsSDK

**Factory method (recommended):**
```typescript
const sdk = OriginalsSDK.create(options?: OriginalsSDKOptions): OriginalsSDK
```

**Constructor:**
```typescript
new OriginalsSDK(config: OriginalsConfig, keyStore?: KeyStore)
```

### OriginalsConfig

```typescript
interface OriginalsConfig {
  // Required
  network: 'mainnet' | 'regtest' | 'signet';
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256';
  
  // Optional
  webvhNetwork?: 'magby' | 'cleffa' | 'pichu';  // default: 'pichu'
  bitcoinRpcUrl?: string;
  enableLogging?: boolean;
  
  // Adapters (required for certain operations)
  ordinalsProvider?: OrdinalsProvider;  // Required for Bitcoin operations
  storageAdapter?: StorageAdapter;
  feeOracle?: FeeOracleAdapter;
  
  // Observability
  telemetry?: TelemetryHooks;
  logging?: {
    level?: 'debug' | 'info' | 'warn' | 'error';
    outputs?: LogOutput[];
    sanitizeLogs?: boolean;
  };
}
```

### SDK Managers

```typescript
sdk.did: DIDManager          // DID creation and resolution
sdk.credentials: CredentialManager  // Verifiable credentials
sdk.lifecycle: LifecycleManager     // Asset lifecycle operations
sdk.bitcoin: BitcoinManager         // Bitcoin/Ordinals operations
```

---

## Kinds System (Typed Originals)

The SDK provides a typed "Kinds" system for creating Originals with specific purposes and validation rules.

### OriginalKind Enum

```typescript
enum OriginalKind {
  App = 'originals:kind:app',       // Executable application
  Agent = 'originals:kind:agent',   // AI agent or autonomous system
  Module = 'originals:kind:module', // Reusable code module
  Dataset = 'originals:kind:dataset', // Structured data collection
  Media = 'originals:kind:media',   // Image, audio, video content
  Document = 'originals:kind:document', // Text document
}
```

### OriginalManifest Interface

```typescript
interface OriginalManifest<K extends OriginalKind> {
  kind: K;
  name: string;
  version: string;  // Semantic version (e.g., "1.0.0")
  description?: string;
  resources: AssetResource[];
  dependencies?: DependencyRef[];
  tags?: string[];
  author?: {
    name?: string;
    did?: string;
    email?: string;
    url?: string;
  };
  license?: string;  // SPDX identifier
  metadata: KindMetadata<K>;  // Kind-specific metadata
}
```

### Kind-Specific Metadata

Each kind has specific metadata requirements:

**AppMetadata:**
```typescript
interface AppMetadata {
  runtime: string;           // 'node', 'browser', 'deno', 'bun'
  entrypoint: string;        // Main file resource ID
  runtimeVersion?: string;
  permissions?: string[];
  platforms?: ('linux' | 'darwin' | 'windows' | 'web')[];
}
```

**ModuleMetadata:**
```typescript
interface ModuleMetadata {
  format: 'esm' | 'commonjs' | 'umd' | 'amd' | 'iife';
  main: string;              // Entrypoint resource ID
  types?: string;            // TypeScript definitions resource ID
  exports?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
```

**AgentMetadata:**
```typescript
interface AgentMetadata {
  capabilities: string[];    // What the agent can do
  model?: {
    provider?: string;
    name: string;
    version?: string;
  };
  inputTypes?: string[];
  outputTypes?: string[];
  systemPrompt?: string;
}
```

**DatasetMetadata:**
```typescript
interface DatasetMetadata {
  schema: Record<string, unknown> | string;  // JSON Schema or URL
  format: string;            // 'csv', 'json', 'parquet', etc.
  recordCount?: number;
  columns?: Array<{ name: string; type: string; description?: string }>;
}
```

**MediaMetadata:**
```typescript
interface MediaMetadata {
  mediaType: 'image' | 'audio' | 'video' | '3d' | 'animation';
  mimeType: string;
  dimensions?: { width: number; height: number };
  duration?: number;         // Seconds for audio/video
  thumbnail?: string;        // Thumbnail resource ID
}
```

**DocumentMetadata:**
```typescript
interface DocumentMetadata {
  format: 'markdown' | 'html' | 'pdf' | 'docx' | 'txt' | 'asciidoc';
  content: string;           // Main content resource ID
  language?: string;         // ISO 639-1
  wordCount?: number;
  toc?: Array<{ title: string; level: number }>;
}
```

### Creating Typed Originals

```typescript
import { OriginalKind, OriginalManifest } from '@originals/sdk';

// Create a Module Original
const moduleAsset = await sdk.lifecycle.createTypedOriginal(
  OriginalKind.Module,
  {
    kind: OriginalKind.Module,
    name: 'my-utility',
    version: '1.0.0',
    description: 'A helpful utility module',
    resources: [{
      id: 'index.js',
      type: 'code',
      hash: 'abc123...',
      contentType: 'application/javascript',
      content: 'export function hello() { return "Hello!"; }'
    }],
    metadata: {
      format: 'esm',
      main: 'index.js',
    }
  }
);
```

### KindRegistry

```typescript
import { KindRegistry, OriginalKind } from '@originals/sdk';

const registry = KindRegistry.getInstance();

// Validate a manifest
const result = registry.validate(manifest);
if (!result.isValid) {
  console.error(result.errors);
}

// Parse kind string
const kind = KindRegistry.parseKind('module');  // OriginalKind.Module

// Create a template
const template = KindRegistry.createTemplate(OriginalKind.App, 'MyApp', '1.0.0');
```

---

## ResourceManager API

The ResourceManager provides CRUD operations for immutable, content-addressed resources with versioning.

### Creating Resources

```typescript
import { ResourceManager } from '@originals/sdk';

const manager = new ResourceManager();

// Create a text resource
const resource = manager.createResource('Hello, World!', {
  type: 'text',
  contentType: 'text/plain',
  id: 'greeting'  // Optional - auto-generated if not provided
});

// Create a binary resource
const imageBuffer = Buffer.from(/* image data */);
const imageResource = manager.createResource(imageBuffer, {
  type: 'image',
  contentType: 'image/png'
});
```

### Updating Resources (Versioning)

```typescript
// Update creates a new version (original is immutable)
const v2 = manager.updateResource(resource, 'Hello, Updated World!', {
  changes: 'Fixed greeting message'
});

console.log(v2.version);            // 2
console.log(v2.previousVersionHash); // Hash of v1
```

### Version History

```typescript
// Get all versions
const history = manager.getResourceHistory(resource.id);

// Get specific version
const v1 = manager.getResourceVersion(resource.id, 1);

// Get current version
const current = manager.getCurrentVersion(resource.id);

// Get detailed history with metadata
const fullHistory = manager.getResourceVersionHistory(resource.id);
// { resourceId, versions, currentVersion, versionCount }
```

### Resource Validation

```typescript
const validation = manager.validateResource(resource);
if (!validation.valid) {
  console.error('Errors:', validation.errors);
}
if (validation.warnings.length > 0) {
  console.warn('Warnings:', validation.warnings);
}

// Verify version chain integrity
const chainValidation = manager.verifyVersionChain(resource.id);
```

### Hashing Content

```typescript
const hash = manager.hashContent('Some content');  // SHA-256 hex string
```

### Resource Types

```typescript
type ResourceType = 
  | 'image' | 'text' | 'code' | 'data' 
  | 'audio' | 'video' | 'document' 
  | 'binary' | 'other';

// Infer type from MIME
const type = ResourceManager.inferResourceType('application/json');  // 'data'
```

---

## DIDManager API

### Creating DIDs

#### did:peer (Private/Offline)
```typescript
// Without key pair return
const didDoc = await sdk.did.createDIDPeer(resources: AssetResource[]): Promise<DIDDocument>

// With key pair return
const { didDocument, keyPair } = await sdk.did.createDIDPeer(
  resources: AssetResource[], 
  true
): Promise<{ didDocument: DIDDocument; keyPair: { privateKey: string; publicKey: string } }>
```

#### did:webvh (Public/HTTPS)
```typescript
const result = await sdk.did.createDIDWebVH(options: CreateWebVHOptions): Promise<CreateWebVHResult>

interface CreateWebVHOptions {
  domain?: string;                    // Defaults to configured webvhNetwork domain
  keyPair?: KeyPair;                  // Auto-generated if not provided
  paths?: string[];                   // URL path segments
  portable?: boolean;                 // Allow DID migration
  outputDir?: string;                 // Save did.jsonl to disk
  externalSigner?: ExternalSigner;    // For external key management
  externalVerifier?: ExternalVerifier;
  verificationMethods?: WebVHVerificationMethod[];
  updateKeys?: string[];
}

interface CreateWebVHResult {
  did: string;
  didDocument: DIDDocument;
  log: DIDLog;
  keyPair: KeyPair;
  logPath?: string;
}
```

### Migrating DIDs

```typescript
// Migrate to did:webvh
const webvhDoc = await sdk.did.migrateToDIDWebVH(
  didDoc: DIDDocument, 
  domain?: string
): Promise<DIDDocument>

// Migrate to did:btco
const btcoDoc = await sdk.did.migrateToDIDBTCO(
  didDoc: DIDDocument, 
  satoshi: string      // Satoshi identifier (0 to 2.1 quadrillion)
): Promise<DIDDocument>
```

### Resolving DIDs

```typescript
const didDoc = await sdk.did.resolveDID(did: string): Promise<DIDDocument | null>
// Supports: did:peer:*, did:webvh:*, did:btco:*
```

### Validating DID Documents

```typescript
const isValid = sdk.did.validateDIDDocument(didDoc: DIDDocument): boolean
```

### DID Log Operations

```typescript
// Save DID log to JSONL file
const logPath = await sdk.did.saveDIDLog(
  did: string, 
  log: DIDLog, 
  baseDir: string
): Promise<string>

// Load DID log from file
const log = await sdk.did.loadDIDLog(logPath: string): Promise<DIDLog>
```

---

## LifecycleManager API

### Clean Lifecycle API (Recommended)

The clean API provides intuitive methods with progress tracking and validation:

```typescript
// Create draft (did:peer)
const draft = await sdk.lifecycle.createDraft(resources, {
  onProgress: (p) => console.log(`${p.percentage}%: ${p.message}`)
});

// Publish (did:webvh)
const published = await sdk.lifecycle.publish(draft, publisherDid, {
  onProgress: (p) => console.log(p.message)
});

// Inscribe (did:btco)
const inscribed = await sdk.lifecycle.inscribe(published, {
  feeRate: 10,
  onProgress: (p) => console.log(p.message)
});

// Transfer ownership
const tx = await sdk.lifecycle.transfer(inscribed, 'bc1q...', {
  onProgress: (p) => console.log(p.message)
});
```

### Creating Assets

```typescript
const asset = await sdk.lifecycle.createAsset(
  resources: AssetResource[]
): Promise<OriginalsAsset>
```

**AssetResource interface:**
```typescript
interface AssetResource {
  id: string;                      // Stable resource ID
  type: string;                    // 'image', 'text', 'code', 'data', etc.
  url?: string;
  content?: string;
  contentType: string;             // MIME type
  hash: string;                    // Content hash (hex)
  size?: number;
  version?: number;                // Default: 1
  previousVersionHash?: string;    // Link to previous version
  createdAt?: string;              // ISO timestamp
}
```

### Creating Typed Originals

```typescript
const asset = await sdk.lifecycle.createTypedOriginal<K extends OriginalKind>(
  kind: K,
  manifest: OriginalManifest<K>,
  options?: CreateTypedOriginalOptions
): Promise<OriginalsAsset>

interface CreateTypedOriginalOptions {
  skipValidation?: boolean;  // Skip validation (not recommended)
  strictMode?: boolean;      // Treat warnings as errors
}
```

### Cost Estimation

```typescript
const cost = await sdk.lifecycle.estimateCost(
  asset: OriginalsAsset,
  targetLayer: LayerType,
  feeRate?: number
): Promise<CostEstimate>

interface CostEstimate {
  totalSats: number;
  breakdown: {
    networkFee: number;
    dataCost: number;
    dustValue: number;
  };
  feeRate: number;
  dataSize: number;
  targetLayer: LayerType;
  confidence: 'low' | 'medium' | 'high';
}
```

### Migration Validation

```typescript
const validation = await sdk.lifecycle.validateMigration(
  asset: OriginalsAsset,
  targetLayer: LayerType
): Promise<MigrationValidation>

interface MigrationValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  currentLayer: LayerType;
  targetLayer: LayerType;
  checks: {
    layerTransition: boolean;
    resourcesValid: boolean;
    credentialsValid: boolean;
    didDocumentValid: boolean;
    bitcoinReadiness?: boolean;
  };
}
```

### Publishing to Web

```typescript
const publishedAsset = await sdk.lifecycle.publishToWeb(
  asset: OriginalsAsset,
  publisherDidOrSigner: string | ExternalSigner
): Promise<OriginalsAsset>
```

### Inscribing on Bitcoin

```typescript
const inscribedAsset = await sdk.lifecycle.inscribeOnBitcoin(
  asset: OriginalsAsset,
  feeRate?: number               // sat/vB (1-1,000,000)
): Promise<OriginalsAsset>
```

### Transferring Ownership

```typescript
const tx = await sdk.lifecycle.transferOwnership(
  asset: OriginalsAsset,
  newOwner: string               // Bitcoin address
): Promise<BitcoinTransaction>
```

### Key Registration

```typescript
await sdk.lifecycle.registerKey(
  verificationMethodId: string,
  privateKey: string             // Multibase-encoded private key
): Promise<void>
```

### Batch Operations

#### Batch Create
```typescript
const result = await sdk.lifecycle.batchCreateAssets(
  resourcesList: AssetResource[][],
  options?: BatchOperationOptions
): Promise<BatchResult<OriginalsAsset>>
```

#### Batch Publish
```typescript
const result = await sdk.lifecycle.batchPublishToWeb(
  assets: OriginalsAsset[],
  domain: string,
  options?: BatchOperationOptions
): Promise<BatchResult<OriginalsAsset>>
```

#### Batch Inscribe (Cost Optimization)
```typescript
const result = await sdk.lifecycle.batchInscribeOnBitcoin(
  assets: OriginalsAsset[],
  options?: BatchInscriptionOptions
): Promise<BatchResult<OriginalsAsset>>

interface BatchInscriptionOptions extends BatchOperationOptions {
  singleTransaction?: boolean;   // Combine into one tx for 30%+ cost savings
  feeRate?: number;
}
```

#### Batch Transfer
```typescript
const result = await sdk.lifecycle.batchTransferOwnership(
  transfers: Array<{ asset: OriginalsAsset; to: string }>,
  options?: BatchOperationOptions
): Promise<BatchResult<BitcoinTransaction>>
```

**BatchResult interface:**
```typescript
interface BatchResult<T> {
  successful: Array<{ index: number; result: T; duration: number }>;
  failed: Array<{ index: number; error: Error; duration: number }>;
  totalProcessed: number;
  totalDuration: number;
  batchId: string;
  startedAt: string;
  completedAt: string;
}
```

---

## OriginalsAsset API

### Properties

```typescript
asset.id: string                     // DID identifier
asset.resources: AssetResource[]     // Asset resources
asset.did: DIDDocument               // DID document
asset.credentials: VerifiableCredential[]
asset.currentLayer: LayerType        // 'did:peer' | 'did:webvh' | 'did:btco'
asset.bindings?: Record<string, string>  // Cross-layer DID mappings
```

### Methods

```typescript
// Migration
await asset.migrate(
  toLayer: LayerType,
  details?: { transactionId?, inscriptionId?, satoshi?, commitTxId?, revealTxId?, feeRate? }
): Promise<void>

// Record ownership transfer
await asset.recordTransfer(from: string, to: string, transactionId: string): Promise<void>

// Provenance
asset.getProvenance(): ProvenanceChain
asset.getProvenanceSummary(): { created, creator, currentLayer, migrationCount, transferCount, lastActivity }
asset.queryProvenance(): ProvenanceQuery  // Fluent API for queries

// Resource versioning
asset.addResourceVersion(
  resourceId: string,
  newContent: string | Buffer,
  contentType: string,
  changes?: string
): AssetResource

asset.getResourceVersion(resourceId: string, version: number): AssetResource | null
asset.getAllVersions(resourceId: string): AssetResource[]
asset.getResourceHistory(resourceId: string): ResourceHistory | null

// Verification
await asset.verify(deps?: {
  didManager?: DIDManager;
  credentialManager?: CredentialManager;
  fetch?: (url: string) => Promise<Response>;
}): Promise<boolean>
```

### ProvenanceChain Structure

```typescript
interface ProvenanceChain {
  createdAt: string;
  creator: string;
  txid?: string;
  migrations: Array<{
    from: LayerType;
    to: LayerType;
    timestamp: string;
    transactionId?: string;
    inscriptionId?: string;
    satoshi?: string;
    commitTxId?: string;
    revealTxId?: string;
    feeRate?: number;
  }>;
  transfers: Array<{
    from: string;
    to: string;
    timestamp: string;
    transactionId: string;
  }>;
  resourceUpdates: Array<{
    resourceId: string;
    fromVersion: number;
    toVersion: number;
    fromHash: string;
    toHash: string;
    timestamp: string;
    changes?: string;
  }>;
}
```

---

## CredentialManager API

### Basic Credential Operations

```typescript
// Create credential
const credential = await sdk.credentials.createResourceCredential(
  type: 'ResourceCreated' | 'ResourceUpdated' | 'ResourceMigrated',
  subject: CredentialSubject,
  issuer: string
): Promise<VerifiableCredential>

// Sign credential with local key
const signed = await sdk.credentials.signCredential(
  credential: VerifiableCredential,
  privateKeyMultibase: string,
  verificationMethod: string
): Promise<VerifiableCredential>

// Sign with external signer
const signed = await sdk.credentials.signCredentialWithExternalSigner(
  credential: VerifiableCredential,
  signer: ExternalSigner
): Promise<VerifiableCredential>

// Verify credential
const isValid = await sdk.credentials.verifyCredential(
  credential: VerifiableCredential
): Promise<boolean>

// Create presentation
const presentation = await sdk.credentials.createPresentation(
  credentials: VerifiableCredential[],
  holder: string
): Promise<VerifiablePresentation>
```

### Credential Factory Methods

The CredentialManager provides specialized factory methods for common credential types:

#### Resource Credential
```typescript
const credential = await sdk.credentials.issueResourceCredential(
  resource: AssetResource,
  assetDid: string,
  creatorDid: string,
  chainOptions?: CredentialChainOptions
): Promise<VerifiableCredential>

// Subject includes: resourceId, resourceType, contentHash, contentType, creator, createdAt
```

#### Resource Update Credential
```typescript
const credential = await sdk.credentials.issueResourceUpdateCredential(
  resourceId: string,
  assetDid: string,
  previousHash: string,
  newHash: string,
  fromVersion: number,
  toVersion: number,
  updaterDid: string,
  updateReason?: string,
  chainOptions?: CredentialChainOptions
): Promise<VerifiableCredential>
```

#### Migration Credential
```typescript
const credential = await sdk.credentials.issueMigrationCredential(
  sourceDid: string,
  targetDid: string | undefined,
  fromLayer: LayerType,
  toLayer: LayerType,
  issuerDid: string,
  details?: {
    transactionId?: string;
    inscriptionId?: string;
    satoshi?: string;
    migrationReason?: string;
  },
  chainOptions?: CredentialChainOptions
): Promise<VerifiableCredential>
```

#### Ownership Transfer Credential
```typescript
const credential = await sdk.credentials.issueOwnershipCredential(
  assetDid: string,
  previousOwner: string,
  newOwner: string,
  transactionId: string,
  issuerDid: string,
  details?: {
    satoshi?: string;
    transferReason?: string;
  },
  chainOptions?: CredentialChainOptions
): Promise<VerifiableCredential>
```

### Credential Chaining

```typescript
interface CredentialChainOptions {
  previousCredentialId?: string;      // Link to previous credential
  previousCredentialHash?: string;    // Hash of previous credential
  expirationDate?: string;
  credentialStatus?: { id: string; type: string; };
}

// Compute credential hash for chaining
const hash = await sdk.credentials.computeCredentialHash(credential);

// Verify credential chain
const result = await sdk.credentials.verifyCredentialChain(credentials);
// { valid: boolean, errors: string[], chainLength: number }
```

### BBS+ Selective Disclosure

```typescript
// Prepare for selective disclosure
const prepared = await sdk.credentials.prepareSelectiveDisclosure(credential, {
  mandatoryPointers: ['/credentialSubject/id'],
  selectivePointers: ['/credentialSubject/name', '/credentialSubject/email']
});

// Create derived proof
const derived = await sdk.credentials.deriveSelectiveProof(
  credential,
  ['/credentialSubject/id', '/credentialSubject/name']
);
// { credential, disclosedFields, hiddenFields }

// Get field by JSON Pointer
const value = sdk.credentials.getFieldByPointer(credential, '/credentialSubject/name');
```

---

## BitcoinManager API

### Inscribing Data

```typescript
const inscription = await sdk.bitcoin.inscribeData(
  data: any,
  contentType: string,          // Valid MIME type
  feeRate?: number              // Max 10,000 sat/vB
): Promise<OrdinalsInscription>

interface OrdinalsInscription {
  satoshi: string;
  inscriptionId: string;
  content: Buffer;
  contentType: string;
  txid: string;
  vout: number;
  blockHeight?: number;
}
```

### Tracking Inscriptions

```typescript
const inscription = await sdk.bitcoin.trackInscription(
  inscriptionId: string
): Promise<OrdinalsInscription | null>
```

### Transferring Inscriptions

```typescript
const tx = await sdk.bitcoin.transferInscription(
  inscription: OrdinalsInscription,
  toAddress: string
): Promise<BitcoinTransaction>
```

### Validation

```typescript
// Validate did:btco exists on Bitcoin
const isValid = await sdk.bitcoin.validateBTCODID(didId: string): Promise<boolean>

// Check for front-running attacks
const isSafe = await sdk.bitcoin.preventFrontRunning(satoshi: string): Promise<boolean>

// Get satoshi from inscription
const satoshi = await sdk.bitcoin.getSatoshiFromInscription(
  inscriptionId: string
): Promise<string | null>
```

---

## Event System

### Subscribing to Events

```typescript
// On LifecycleManager
const unsubscribe = sdk.lifecycle.on('asset:created', (event) => {
  console.log('Asset created:', event.asset.id);
});

// On OriginalsAsset
const unsubscribe = asset.on('asset:migrated', (event) => {
  console.log(`Migrated from ${event.asset.fromLayer} to ${event.asset.toLayer}`);
});

// One-time subscription
sdk.lifecycle.once('batch:completed', handler);

// Unsubscribe
unsubscribe();
// or: sdk.lifecycle.off('asset:created', handler);
```

### Event Types

```typescript
// Asset events
'asset:created'        // New asset created
'asset:migrated'       // Asset migrated between layers
'asset:transferred'    // Ownership transferred

// Resource events
'resource:published'   // Resource published to web
'resource:version:created'  // New resource version

// Credential events
'credential:issued'    // Credential issued

// Batch events
'batch:started'        // Batch operation started
'batch:progress'       // Batch progress update
'batch:completed'      // Batch completed
'batch:failed'         // Batch failed

// Migration events (MigrationManager)
'migration:started'
'migration:validated'
'migration:checkpointed'
'migration:in_progress'
'migration:anchoring'
'migration:completed'
'migration:failed'
'migration:rolledback'
'migration:quarantine'

// Verification
'verification:completed'
```

---

## External Signer Pattern

For integration with external key management (Turnkey, AWS KMS, HSMs):

```typescript
interface ExternalSigner {
  sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }>;
  
  getVerificationMethodId(): string | Promise<string>;
}

interface ExternalVerifier {
  verify(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array
  ): Promise<boolean>;
}
```

**Usage:**
```typescript
const result = await sdk.did.createDIDWebVH({
  externalSigner: myPrivySigner,
  externalVerifier: myPrivyVerifier,
  verificationMethods: [{
    type: 'Multikey',
    publicKeyMultibase: 'z6Mk...'
  }],
  updateKeys: ['did:key:z6Mk...']
});
```

---

## Storage Adapters

### StorageAdapter Interface

```typescript
interface StorageAdapter {
  put(objectKey: string, data: Buffer | string, options?: StoragePutOptions): Promise<string>;
  get(objectKey: string): Promise<StorageGetResult | null>;
  delete?(objectKey: string): Promise<boolean>;
}

interface StoragePutOptions {
  contentType?: string;
  cacheControl?: string;
}

interface StorageGetResult {
  content: Buffer;
  contentType: string;
}
```

### Built-in Adapters

```typescript
import { MemoryStorageAdapter, LocalStorageAdapter } from '@originals/sdk';

// In-memory storage (testing)
const memory = new MemoryStorageAdapter();

// Browser localStorage
const local = new LocalStorageAdapter();
```

---

## OrdinalsProvider Interface

```typescript
interface OrdinalsProvider {
  getInscriptionById(id: string): Promise<InscriptionInfo | null>;
  getInscriptionsBySatoshi(satoshi: string): Promise<Array<{ inscriptionId: string }>>;
  broadcastTransaction(txHexOrObj: unknown): Promise<string>;
  getTransactionStatus(txid: string): Promise<{ confirmed: boolean; blockHeight?: number; confirmations?: number }>;
  estimateFee(blocks?: number): Promise<number>;
  createInscription(params: {
    data: Buffer;
    contentType: string;
    feeRate?: number;
  }): Promise<InscriptionResult>;
  transferInscription(
    inscriptionId: string,
    toAddress: string,
    options?: { feeRate?: number }
  ): Promise<TransferResult>;
}
```

### Using OrdMockProvider (Testing)

```typescript
import { OrdMockProvider } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  ordinalsProvider: new OrdMockProvider(),
});
```

---

## Multikey Encoding

All keys use **multibase+multicodec encoding** (not JWK):

```typescript
import { multikey } from '@originals/sdk';

// Encode keys
const publicKeyMultibase = multikey.encodePublicKey(publicKeyBytes, 'Ed25519');
const privateKeyMultibase = multikey.encodePrivateKey(privateKeyBytes, 'Ed25519');

// Decode keys
const { key, type } = multikey.decodePublicKey(publicKeyMultibase);
const { key, type } = multikey.decodePrivateKey(privateKeyMultibase);

// Encode arbitrary data as multibase
const multibaseEncoded = multikey.encodeMultibase(dataBytes);
```

**Supported key types:** `'Ed25519'`, `'Secp256k1'`, `'P256'`, `'Bls12381G2'`

**Key format:** `z` prefix + base58btc encoding + multicodec header

---

## Complete Usage Examples

### Basic Lifecycle Flow

```typescript
import { 
  OriginalsSDK, 
  OrdMockProvider
} from '@originals/sdk';
import { sha256 } from '@noble/hashes/sha2.js';

// 1. Configure SDK
const sdk = OriginalsSDK.create({
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  webvhNetwork: 'magby',
  ordinalsProvider: new OrdMockProvider(),
});

// 2. Create asset resources
const content = 'Hello, Originals!';
const contentBuffer = Buffer.from(content);
const hash = Buffer.from(sha256(contentBuffer)).toString('hex');

const resources = [{
  id: 'my-resource',
  type: 'text',
  content,
  contentType: 'text/plain',
  hash,
  size: contentBuffer.length,
}];

// 3. Create asset (did:peer layer)
const asset = await sdk.lifecycle.createAsset(resources);
console.log('Created:', asset.id); // did:peer:4z...

// 4. Subscribe to events
asset.on('asset:migrated', (event) => {
  console.log(`Migrated to ${event.asset.toLayer}`);
});

// 5. Publish to web (did:webvh layer)
const published = await sdk.lifecycle.publishToWeb(
  asset,
  'localhost:5000'
);
console.log('Published:', published.id);

// 6. Inscribe on Bitcoin (did:btco layer)
const inscribed = await sdk.lifecycle.inscribeOnBitcoin(
  published,
  10 // fee rate in sat/vB
);
console.log('Inscribed:', inscribed.id);

// 7. Check provenance
const provenance = inscribed.getProvenance();
console.log('Migrations:', provenance.migrations.length); // 2

// 8. Transfer ownership
const tx = await sdk.lifecycle.transferOwnership(
  inscribed,
  'bc1q...' // Bitcoin address
);
console.log('Transfer txid:', tx.txid);
```

### Creating a Typed Module Original

```typescript
import { OriginalsSDK, OriginalKind, OrdMockProvider } from '@originals/sdk';
import { sha256 } from '@noble/hashes/sha2.js';

const sdk = OriginalsSDK.create({
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  ordinalsProvider: new OrdMockProvider(),
});

// Create module content
const moduleCode = `
export function greet(name) {
  return \`Hello, \${name}!\`;
}

export function add(a, b) {
  return a + b;
}
`;

const hash = Buffer.from(sha256(Buffer.from(moduleCode))).toString('hex');

// Create typed Module Original
const moduleAsset = await sdk.lifecycle.createTypedOriginal(
  OriginalKind.Module,
  {
    kind: OriginalKind.Module,
    name: 'my-utility',
    version: '1.0.0',
    description: 'A simple utility module',
    resources: [{
      id: 'index.js',
      type: 'code',
      content: moduleCode,
      contentType: 'application/javascript',
      hash,
      size: moduleCode.length,
    }],
    tags: ['utility', 'greet'],
    author: {
      name: 'Developer',
    },
    license: 'MIT',
    metadata: {
      format: 'esm',
      main: 'index.js',
      exports: {
        '.': './index.js',
      },
    },
  }
);

console.log('Created module:', moduleAsset.id);

// Estimate cost before inscribing
const cost = await sdk.lifecycle.estimateCost(moduleAsset, 'did:btco');
console.log(`Estimated inscription cost: ${cost.totalSats} sats`);

// Validate migration
const validation = await sdk.lifecycle.validateMigration(moduleAsset, 'did:webvh');
if (validation.valid) {
  const published = await sdk.lifecycle.publish(moduleAsset, 'example.com');
  console.log('Published:', published.id);
}
```

---

## Common Patterns

### Error Handling

```typescript
import { StructuredError } from '@originals/sdk';

try {
  await sdk.bitcoin.inscribeData(data, 'application/json');
} catch (error) {
  if (error instanceof StructuredError) {
    console.error(`${error.code}: ${error.message}`);
    // Common codes: ORD_PROVIDER_REQUIRED, INVALID_INPUT, INVALID_ADDRESS
  }
}
```

### Validation Utilities

```typescript
import { 
  validateBitcoinAddress,
  validateSatoshiNumber,
  validateDIDDocument,
  validateCredential 
} from '@originals/sdk';

// Bitcoin address validation
validateBitcoinAddress(address, 'regtest'); // throws on invalid

// Satoshi number validation
const result = validateSatoshiNumber('1234567890');
if (!result.valid) console.error(result.error);

// DID document validation
const isValid = validateDIDDocument(didDoc);

// Credential structure validation
const isValid = validateCredential(credential);
```

### Hash Computation

```typescript
import { sha256Bytes, hashResource } from '@originals/sdk';

// Hash bytes
const hash = sha256Bytes(data);

// Hash for resources (used in AssetResource.hash)
const resourceHash = hashResource(Buffer.from(content));
```

---

## Type Reference

### Core Types

```typescript
type LayerType = 'did:peer' | 'did:webvh' | 'did:btco';
type KeyType = 'ES256K' | 'Ed25519' | 'ES256';
type MultikeyType = 'Ed25519' | 'Secp256k1' | 'P256' | 'Bls12381G2';
type WebVHNetworkName = 'magby' | 'cleffa' | 'pichu';
type BitcoinNetworkName = 'mainnet' | 'regtest' | 'signet';
```

### DID Types

```typescript
interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
  keyAgreement?: (string | VerificationMethod)[];
  service?: ServiceEndpoint[];
  controller?: string[];
  alsoKnownAs?: string[];
}

interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
  revoked?: string;
  compromised?: string;
}

interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string | object;
}

interface KeyPair {
  privateKey: string;  // multibase encoded
  publicKey: string;   // multibase encoded
}
```

### Bitcoin Types

```typescript
interface BitcoinTransaction {
  txid: string;
  vin: TransactionInput[];
  vout: TransactionOutput[];
  fee: number;
  blockHeight?: number;
  confirmations?: number;
}

interface Utxo {
  txid: string;
  vout: number;
  value: number;           // satoshis
  scriptPubKey?: string;
  address?: string;
  inscriptions?: string[];
  locked?: boolean;
}

const DUST_LIMIT_SATS = 546;
```

### Credential Types

```typescript
interface VerifiableCredential {
  '@context': string[];
  type: string[];
  id?: string;
  issuer: string | Issuer;
  issuanceDate: string;
  expirationDate?: string;
  credentialSubject: CredentialSubject;
  proof?: Proof | Proof[];
}

interface Proof {
  type: string;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  proofValue: string;
}

interface VerifiablePresentation {
  '@context': string[];
  type: string[];
  holder: string;
  verifiableCredential: VerifiableCredential[];
  proof?: Proof | Proof[];
}
```

---

## Gotchas and Best Practices

### Critical Rules

1. **Bitcoin operations require `ordinalsProvider`** - Always configure when using `inscribeData`, `transferInscription`, etc.

2. **Keys use Multikey encoding, NOT JWK** - Use `multikey.encodePublicKey()` / `decodePublicKey()`

3. **Migration is unidirectional** - `did:peer → did:webvh → did:btco` only

4. **External signer pattern** - Provide EITHER `keyPair` OR `externalSigner`, never both

5. **Satoshi validation** - Always validate satoshi numbers (must be 0 to 2.1 quadrillion)

6. **Address validation** - Use `validateBitcoinAddress()` with correct network

7. **Fee rate limits** - Max 10,000 sat/vB to prevent accidental fund drainage

8. **Use typed Originals** - Prefer `createTypedOriginal` over `createAsset` for proper validation

9. **Validate before migration** - Use `validateMigration()` for pre-flight checks

10. **Estimate costs first** - Use `estimateCost()` before Bitcoin operations

### Import Patterns

```typescript
// ✅ Correct noble crypto import
import { sha256 } from '@noble/hashes/sha2.js';

// ❌ Wrong - will fail
import { sha256 } from '@noble/hashes/sha256';
```

### Testing Pattern

```typescript
// Always use OrdMockProvider for tests
const sdk = OriginalsSDK.create({
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  ordinalsProvider: new OrdMockProvider(),
});
```

---

## Module Exports

```typescript
// Main entry
export { OriginalsSDK } from './core/OriginalsSDK';
export { OriginalsAsset } from './lifecycle/OriginalsAsset';

// Managers
export { DIDManager } from './did/DIDManager';
export { KeyManager } from './did/KeyManager';
export { CredentialManager } from './vc/CredentialManager';
export { LifecycleManager } from './lifecycle/LifecycleManager';
export { BitcoinManager } from './bitcoin/BitcoinManager';
export { MigrationManager } from './migration';

// Resource Management
export { ResourceManager } from './resources';

// Kinds System
export { OriginalKind, KindRegistry } from './kinds';

// Crypto
export { Signer, ES256KSigner, Ed25519Signer, ES256Signer } from './crypto/Signer';
export { multikey } from './crypto/Multikey';

// Storage
export { MemoryStorageAdapter, LocalStorageAdapter } from './storage';

// Adapters
export { OrdMockProvider } from './adapters/providers/OrdMockProvider';
export { FeeOracleMock } from './adapters/FeeOracleMock';

// Types - all exported from './types'
export * from './types';

// Events
export * from './events';

// Utilities
export * from './utils/validation';
export * from './utils/satoshi-validation';
export * from './utils/bitcoin-address';
export { sha256Bytes } from './utils/hash';
```
