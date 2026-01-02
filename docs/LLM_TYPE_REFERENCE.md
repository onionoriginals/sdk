# Originals SDK Type Reference

> Complete type definitions for LLM agents. Use this as a reference for exact interface shapes.

## Table of Contents

1. [Configuration Types](#configuration-types)
2. [DID Types](#did-types)
3. [Asset Types](#asset-types)
4. [Resource Types](#resource-types)
5. [Kinds System Types](#kinds-system-types)
6. [Credential Types](#credential-types)
7. [Lifecycle Types](#lifecycle-types)
8. [Bitcoin Types](#bitcoin-types)
9. [Event Types](#event-types)
10. [Adapter Types](#adapter-types)
11. [Network Types](#network-types)
12. [Utility Types](#utility-types)

---

## Configuration Types

### OriginalsConfig

```typescript
interface OriginalsConfig {
  /** Bitcoin network */
  network: 'mainnet' | 'regtest' | 'signet';
  
  /** Default cryptographic key type */
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256';
  
  /** Bitcoin RPC URL (optional) */
  bitcoinRpcUrl?: string;
  
  /** WebVH network tier (default: 'pichu') */
  webvhNetwork?: 'magby' | 'cleffa' | 'pichu';
  
  /** Enable console logging */
  enableLogging?: boolean;
  
  /** Key store for private key management */
  keyStore?: KeyStore;
  
  /** Storage adapter for asset resources */
  storageAdapter?: StorageAdapter;
  
  /** Fee oracle for dynamic fee estimation */
  feeOracle?: FeeOracleAdapter;
  
  /** Ordinals provider for Bitcoin operations (REQUIRED for Bitcoin ops) */
  ordinalsProvider?: OrdinalsProvider;
  
  /** Telemetry hooks for observability */
  telemetry?: TelemetryHooks;
  
  /** Enhanced logging configuration */
  logging?: {
    level?: 'debug' | 'info' | 'warn' | 'error';
    outputs?: LogOutput[];
    includeTimestamps?: boolean;
    includeContext?: boolean;
    eventLogging?: EventLoggingConfig;
    sanitizeLogs?: boolean;
  };
  
  /** Metrics configuration */
  metrics?: {
    enabled?: boolean;
    exportFormat?: 'json' | 'prometheus';
    collectCache?: boolean;
  };
}
```

### OriginalsSDKOptions

```typescript
interface OriginalsSDKOptions extends Partial<OriginalsConfig> {
  keyStore?: KeyStore;
}
```

### KeyStore

```typescript
interface KeyStore {
  /** Retrieve private key for a verification method */
  getPrivateKey(verificationMethodId: string): Promise<string | null>;
  
  /** Store private key for a verification method */
  setPrivateKey(verificationMethodId: string, privateKey: string): Promise<void>;
}
```

---

## DID Types

### DIDDocument

```typescript
interface DIDDocument {
  /** JSON-LD context */
  '@context': string[];
  
  /** DID identifier (e.g., 'did:peer:4z...') */
  id: string;
  
  /** Cryptographic verification methods */
  verificationMethod?: VerificationMethod[];
  
  /** Authentication key references */
  authentication?: (string | VerificationMethod)[];
  
  /** Assertion key references */
  assertionMethod?: (string | VerificationMethod)[];
  
  /** Key agreement references */
  keyAgreement?: (string | VerificationMethod)[];
  
  /** Capability invocation references */
  capabilityInvocation?: (string | VerificationMethod)[];
  
  /** Capability delegation references */
  capabilityDelegation?: (string | VerificationMethod)[];
  
  /** Service endpoints */
  service?: ServiceEndpoint[];
  
  /** DID controllers */
  controller?: string[];
  
  /** Alternate identifiers */
  alsoKnownAs?: string[];
}
```

### VerificationMethod

```typescript
interface VerificationMethod {
  /** Verification method ID (e.g., '#key-0' or absolute URI) */
  id: string;
  
  /** Key type (e.g., 'Multikey', 'Ed25519VerificationKey2020') */
  type: string;
  
  /** Controller DID */
  controller: string;
  
  /** Public key in multibase encoding */
  publicKeyMultibase: string;
  
  /** ISO 8601 timestamp when key was revoked (optional) */
  revoked?: string;
  
  /** ISO 8601 timestamp when key was compromised (optional) */
  compromised?: string;
}
```

### ServiceEndpoint

```typescript
interface ServiceEndpoint {
  /** Service ID (e.g., '#my-service') */
  id: string;
  
  /** Service type */
  type: string;
  
  /** Service endpoint URL or object */
  serviceEndpoint: string | object;
}
```

### KeyPair

```typescript
interface KeyPair {
  /** Private key in multibase encoding */
  privateKey: string;
  
  /** Public key in multibase encoding */
  publicKey: string;
}
```

### CreateWebVHOptions

```typescript
interface CreateWebVHOptions {
  /** Domain for the DID (defaults to configured webvhNetwork domain) */
  domain?: string;
  
  /** Key pair (auto-generated if not provided) */
  keyPair?: KeyPair;
  
  /** URL path segments (e.g., ['user', 'alice']) */
  paths?: string[];
  
  /** Allow DID migration */
  portable?: boolean;
  
  /** Output directory for did.jsonl file */
  outputDir?: string;
  
  /** External signer (alternative to keyPair) */
  externalSigner?: ExternalSigner;
  
  /** External verifier */
  externalVerifier?: ExternalVerifier;
  
  /** Verification methods (required with externalSigner) */
  verificationMethods?: WebVHVerificationMethod[];
  
  /** Update authorization keys (required with externalSigner) */
  updateKeys?: string[];
}
```

### CreateWebVHResult

```typescript
interface CreateWebVHResult {
  /** Created DID identifier */
  did: string;
  
  /** DID document */
  didDocument: DIDDocument;
  
  /** DID version history log */
  log: DIDLog;
  
  /** Generated or provided key pair */
  keyPair: KeyPair;
  
  /** Path to saved did.jsonl file (if outputDir provided) */
  logPath?: string;
}
```

### DIDLog / DIDLogEntry

```typescript
type DIDLog = DIDLogEntry[];

interface DIDLogEntry {
  /** Version identifier */
  versionId: string;
  
  /** Version timestamp */
  versionTime: string;
  
  /** DID parameters */
  parameters: Record<string, unknown>;
  
  /** DID document state */
  state: Record<string, unknown>;
  
  /** Cryptographic proofs */
  proof?: Record<string, unknown>[];
}
```

---

## Asset Types

### AssetResource

```typescript
interface AssetResource {
  /** Stable resource identifier */
  id: string;
  
  /** Resource type ('image', 'text', 'code', 'data', etc.) */
  type: string;
  
  /** Resource URL (set after publishing) */
  url?: string;
  
  /** Inline content */
  content?: string;
  
  /** MIME content type */
  contentType: string;
  
  /** Content hash in hex format */
  hash: string;
  
  /** Content size in bytes */
  size?: number;
  
  /** Version number (default: 1) */
  version?: number;
  
  /** Hash linking to previous version */
  previousVersionHash?: string;
  
  /** ISO 8601 creation timestamp */
  createdAt?: string;
}
```

### ProvenanceChain

```typescript
interface ProvenanceChain {
  /** Asset creation timestamp */
  createdAt: string;
  
  /** Creator DID */
  creator: string;
  
  /** Latest transaction ID */
  txid?: string;
  
  /** Migration history */
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
  
  /** Transfer history */
  transfers: Array<{
    from: string;
    to: string;
    timestamp: string;
    transactionId: string;
  }>;
  
  /** Resource update history */
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

### LayerType

```typescript
type LayerType = 'did:peer' | 'did:webvh' | 'did:btco';
```

---

## Resource Types

### Resource

```typescript
interface Resource extends AssetResource {
  /** The actual content (for in-memory resources) */
  content?: string;
  
  /** Binary content as base64-encoded string */
  contentBase64?: string;
  
  /** Description of the resource */
  description?: string;
}
```

### ResourceType

```typescript
type ResourceType = 
  | 'image'
  | 'text'
  | 'code'
  | 'data'
  | 'audio'
  | 'video'
  | 'document'
  | 'binary'
  | 'other';
```

### ResourceOptions

```typescript
interface ResourceOptions {
  /** Logical resource ID (optional - will be generated if not provided) */
  id?: string;
  
  /** Resource type category */
  type: ResourceType;
  
  /** MIME content type (e.g., 'text/plain', 'image/png') */
  contentType: string;
  
  /** Optional URL if resource is externally hosted */
  url?: string;
  
  /** Optional description of the resource */
  description?: string;
  
  /** Maximum allowed size in bytes (optional) */
  maxSize?: number;
}
```

### ResourceUpdateOptions

```typescript
interface ResourceUpdateOptions {
  /** New content type (inherits from previous version if not specified) */
  contentType?: string;
  
  /** Description of changes made in this version */
  changes?: string;
}
```

### ResourceVersionHistory

```typescript
interface ResourceVersionHistory {
  /** Logical resource ID (stable across all versions) */
  resourceId: string;
  
  /** All versions in chronological order (oldest first) */
  versions: Resource[];
  
  /** The current (latest) version */
  currentVersion: Resource;
  
  /** Total number of versions */
  versionCount: number;
}
```

### ResourceValidationResult

```typescript
interface ResourceValidationResult {
  /** Whether the resource is valid */
  valid: boolean;
  
  /** Array of error messages if validation failed */
  errors: string[];
  
  /** Array of warning messages (non-fatal issues) */
  warnings: string[];
}
```

### ResourceManagerConfig

```typescript
interface ResourceManagerConfig {
  /** Default maximum resource size in bytes (default: 10MB) */
  defaultMaxSize?: number;
  
  /** Whether to store content in memory (default: true) */
  storeContent?: boolean;
  
  /** Allowed MIME types (if empty, all types allowed) */
  allowedContentTypes?: string[];
  
  /** Whether to enable strict MIME type validation (default: true) */
  strictMimeValidation?: boolean;
}
```

---

## Kinds System Types

### OriginalKind

```typescript
enum OriginalKind {
  /** Executable application with runtime and entrypoint */
  App = 'originals:kind:app',
  
  /** AI agent or autonomous system with capabilities and model info */
  Agent = 'originals:kind:agent',
  
  /** Reusable code module with exports and dependencies */
  Module = 'originals:kind:module',
  
  /** Structured data collection with schema definition */
  Dataset = 'originals:kind:dataset',
  
  /** Media content (image, audio, video) with format metadata */
  Media = 'originals:kind:media',
  
  /** Text document with formatting and sections */
  Document = 'originals:kind:document',
}
```

### DependencyRef

```typescript
interface DependencyRef {
  /** DID of the dependency Original */
  did: string;
  
  /** Semantic version constraint (e.g., "^1.0.0", ">=2.0.0") */
  version?: string;
  
  /** Human-readable name of the dependency */
  name?: string;
  
  /** Whether this dependency is required (default: true) */
  optional?: boolean;
}
```

### BaseManifest

```typescript
interface BaseManifest {
  /** Human-readable name */
  name: string;
  
  /** Semantic version string (e.g., "1.0.0") */
  version: string;
  
  /** Optional description */
  description?: string;
  
  /** Resources associated with this Original */
  resources: AssetResource[];
  
  /** Dependencies on other Originals */
  dependencies?: DependencyRef[];
  
  /** Free-form tags for categorization */
  tags?: string[];
  
  /** Author information */
  author?: {
    name?: string;
    did?: string;
    email?: string;
    url?: string;
  };
  
  /** License identifier (SPDX) */
  license?: string;
  
  /** URL for more information */
  homepage?: string;
  
  /** Repository URL */
  repository?: string;
}
```

### OriginalManifest

```typescript
interface OriginalManifest<K extends OriginalKind = OriginalKind> extends BaseManifest {
  /** The kind of Original */
  kind: K;
  
  /** Kind-specific metadata */
  metadata: KindMetadata<K>;
}
```

### Kind-Specific Metadata Types

```typescript
interface AppMetadata {
  runtime: string;                    // 'node', 'browser', 'deno', 'bun'
  entrypoint: string;                 // Main file resource ID
  runtimeVersion?: string;
  minRuntimeVersion?: string;
  permissions?: string[];
  env?: Record<string, { description?: string; required?: boolean; default?: string }>;
  platforms?: ('linux' | 'darwin' | 'windows' | 'web')[];
  icons?: Record<string, string>;
  commands?: Record<string, { description: string; args?: string[] }>;
}

interface AgentMetadata {
  capabilities: string[];             // Required - what the agent can do
  model?: {
    provider?: string;
    name: string;
    version?: string;
    parameters?: Record<string, unknown>;
  };
  inputTypes?: string[];
  outputTypes?: string[];
  memory?: { type: 'stateless' | 'session' | 'persistent'; maxSize?: number };
  systemPrompt?: string;
  tools?: Array<{ name: string; description: string; parameters?: Record<string, unknown> }>;
  rateLimit?: { requestsPerMinute?: number; tokensPerMinute?: number };
}

interface ModuleMetadata {
  format: 'esm' | 'commonjs' | 'umd' | 'amd' | 'iife';
  main: string;                       // Main entrypoint resource ID
  types?: string;                     // TypeScript definitions resource ID
  exports?: Record<string, string | { import?: string; require?: string; types?: string }>;
  peerDependencies?: Record<string, string>;
  browser?: string;
  files?: string[];
  sideEffects?: boolean | string[];
  typescript?: { strict?: boolean; target?: string; moduleResolution?: string };
}

interface DatasetMetadata {
  schema: Record<string, unknown> | string;  // JSON Schema or URL
  format: string;                     // 'csv', 'json', 'parquet', etc.
  recordCount?: number;
  columns?: Array<{ name: string; type: string; description?: string; nullable?: boolean }>;
  source?: { origin?: string; collectedAt?: string; methodology?: string };
  statistics?: { sizeBytes?: number; compression?: string; checksums?: Record<string, string> };
  dataLicense?: string;
  privacy?: 'public' | 'internal' | 'confidential' | 'restricted';
  updateFrequency?: 'realtime' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'static';
}

interface MediaMetadata {
  mediaType: 'image' | 'audio' | 'video' | '3d' | 'animation';
  mimeType: string;
  dimensions?: { width: number; height: number; aspectRatio?: string };
  duration?: number;                  // Seconds for audio/video
  frameRate?: number;
  audioChannels?: number;
  sampleRate?: number;
  codec?: string;
  bitrate?: number;
  colorSpace?: string;
  thumbnail?: string;                 // Thumbnail resource ID
  preview?: string;                   // Preview resource ID
  altText?: string;
  caption?: string;
  exif?: Record<string, unknown>;
}

interface DocumentMetadata {
  format: 'markdown' | 'html' | 'pdf' | 'docx' | 'txt' | 'asciidoc' | 'rst' | 'latex';
  language?: string;                  // ISO 639-1
  content: string;                    // Main content resource ID
  toc?: Array<{ title: string; level: number; anchor?: string }>;
  pageCount?: number;
  wordCount?: number;
  readingTime?: number;               // Minutes
  keywords?: string[];
  abstract?: string;
  references?: Array<{ id: string; title: string; authors?: string[]; year?: number; url?: string; doi?: string }>;
  status?: 'draft' | 'review' | 'published' | 'archived';
  revision?: number;
}
```

### KindValidationResult

```typescript
interface ValidationResult {
  /** Whether the manifest is valid */
  isValid: boolean;
  
  /** Validation errors if any */
  errors: ValidationError[];
  
  /** Validation warnings (non-fatal) */
  warnings: ValidationWarning[];
}

interface ValidationError {
  /** Error code */
  code: string;
  
  /** Human-readable message */
  message: string;
  
  /** Path to the invalid field (e.g., "metadata.entrypoint") */
  path?: string;
  
  /** The invalid value */
  value?: unknown;
}

interface ValidationWarning {
  /** Warning code */
  code: string;
  
  /** Human-readable message */
  message: string;
  
  /** Path to the field with warning */
  path?: string;
  
  /** Suggested fix */
  suggestion?: string;
}
```

### CreateTypedOriginalOptions

```typescript
interface CreateTypedOriginalOptions {
  /** Skip validation (not recommended) */
  skipValidation?: boolean;
  
  /** Treat warnings as errors */
  strictMode?: boolean;
}
```

---

## Credential Types

### VerifiableCredential

```typescript
interface VerifiableCredential {
  /** JSON-LD context */
  '@context': string[];
  
  /** Credential types (e.g., ['VerifiableCredential', 'ResourceCreated']) */
  type: string[];
  
  /** Credential identifier */
  id?: string;
  
  /** Issuer DID or object */
  issuer: string | Issuer;
  
  /** ISO 8601 issuance date */
  issuanceDate: string;
  
  /** ISO 8601 expiration date */
  expirationDate?: string;
  
  /** Credential claims */
  credentialSubject: CredentialSubject;
  
  /** Credential status information */
  credentialStatus?: CredentialStatus;
  
  /** Cryptographic proof(s) */
  proof?: Proof | Proof[];
}
```

### Issuer

```typescript
interface Issuer {
  /** Issuer DID */
  id: string;
  
  /** Issuer display name */
  name?: string;
}
```

### CredentialSubject

```typescript
interface CredentialSubject {
  /** Subject identifier (usually a DID) */
  id?: string;
  
  /** Additional claims (extensible) */
  [key: string]: any;
}
```

### CredentialStatus

```typescript
interface CredentialStatus {
  /** Status endpoint */
  id: string;
  
  /** Status type */
  type: string;
}
```

### Proof

```typescript
interface Proof {
  /** Proof type (e.g., 'DataIntegrityProof') */
  type: string;
  
  /** ISO 8601 creation timestamp */
  created: string;
  
  /** Verification method used for signing */
  verificationMethod: string;
  
  /** Purpose (e.g., 'assertionMethod') */
  proofPurpose: string;
  
  /** Signature value in multibase encoding */
  proofValue: string;
}
```

### VerifiablePresentation

```typescript
interface VerifiablePresentation {
  /** JSON-LD context */
  '@context': string[];
  
  /** Presentation types */
  type: string[];
  
  /** Presentation identifier */
  id?: string;
  
  /** Holder DID */
  holder: string;
  
  /** Contained credentials */
  verifiableCredential: VerifiableCredential[];
  
  /** Presentation proof */
  proof?: Proof | Proof[];
}
```

### Specialized Credentials

```typescript
// Resource creation credential
interface ResourceCreatedCredential extends VerifiableCredential {
  credentialSubject: {
    id: string;
    resourceId: string;
    resourceType: string;
    createdAt: string;
    creator: string;
  };
}

// Resource migration credential
interface ResourceMigratedCredential extends VerifiableCredential {
  credentialSubject: {
    id: string;
    resourceId: string;
    fromLayer: LayerType;
    toLayer: LayerType;
    migratedAt: string;
    migrationReason?: string;
  };
}

// Key recovery credential
interface KeyRecoveryCredential extends VerifiableCredential {
  credentialSubject: {
    id: string;                          // DID that was recovered
    recoveredAt: string;                  // ISO 8601 timestamp
    recoveryReason: string;               // "key_compromise" or other
    previousVerificationMethods: string[]; // IDs of compromised keys
    newVerificationMethod: string;         // ID of new key
  };
}
```

### Credential Factory Types

```typescript
// Subject for ResourceCreated credential
interface ResourceCreatedSubject {
  id: string;
  resourceId: string;
  resourceType: string;
  contentHash: string;
  contentType: string;
  creator: string;
  createdAt: string;
}

// Subject for ResourceUpdated credential
interface ResourceUpdatedSubject {
  id: string;
  resourceId: string;
  previousHash: string;
  newHash: string;
  fromVersion: number;
  toVersion: number;
  updatedAt: string;
  updateReason?: string;
}

// Subject for MigrationCompleted credential
interface MigrationSubject {
  id: string;
  sourceDid: string;
  targetDid?: string;
  fromLayer: LayerType;
  toLayer: LayerType;
  migratedAt: string;
  transactionId?: string;
  inscriptionId?: string;
  satoshi?: string;
  migrationReason?: string;
}

// Subject for OwnershipTransferred credential
interface OwnershipSubject {
  id: string;
  previousOwner: string;
  newOwner: string;
  transferredAt: string;
  transactionId: string;
  satoshi?: string;
  transferReason?: string;
}

// Options for credential chaining
interface CredentialChainOptions {
  previousCredentialId?: string;
  previousCredentialHash?: string;
  expirationDate?: string;
  credentialStatus?: { id: string; type: string };
}

// Options for BBS+ selective disclosure
interface SelectiveDisclosureOptions {
  mandatoryPointers: string[];   // JSON Pointer paths that must always be disclosed
  selectivePointers?: string[];  // JSON Pointer paths the holder can selectively disclose
}

// Result of creating a derived proof with selective disclosure
interface DerivedProofResult {
  credential: VerifiableCredential;
  disclosedFields: string[];
  hiddenFields: string[];
}
```

---

## Lifecycle Types

### CostEstimate

```typescript
interface CostEstimate {
  /** Total estimated cost in satoshis */
  totalSats: number;
  
  /** Breakdown of costs */
  breakdown: {
    /** Network fee in satoshis */
    networkFee: number;
    /** Data cost for inscription (sat/vB * size) */
    dataCost: number;
    /** Dust output value */
    dustValue: number;
  };
  
  /** Fee rate used for estimation (sat/vB) */
  feeRate: number;
  
  /** Data size in bytes */
  dataSize: number;
  
  /** Target layer for the migration */
  targetLayer: LayerType;
  
  /** Confidence level of estimate */
  confidence: 'low' | 'medium' | 'high';
}
```

### MigrationValidation

```typescript
interface MigrationValidation {
  /** Whether the migration is valid */
  valid: boolean;
  
  /** List of validation errors */
  errors: string[];
  
  /** List of warnings (non-blocking) */
  warnings: string[];
  
  /** Current layer of the asset */
  currentLayer: LayerType;
  
  /** Target layer for migration */
  targetLayer: LayerType;
  
  /** Checks performed */
  checks: {
    layerTransition: boolean;
    resourcesValid: boolean;
    credentialsValid: boolean;
    didDocumentValid: boolean;
    bitcoinReadiness?: boolean;
  };
}
```

### LifecycleProgress

```typescript
interface LifecycleProgress {
  /** Current operation phase */
  phase: 'preparing' | 'validating' | 'processing' | 'committing' | 'confirming' | 'complete' | 'failed';
  
  /** Progress percentage (0-100) */
  percentage: number;
  
  /** Human-readable message */
  message: string;
  
  /** Current operation details */
  details?: {
    currentStep?: number;
    totalSteps?: number;
    transactionId?: string;
    confirmations?: number;
  };
}
```

### LifecycleOperationOptions

```typescript
interface LifecycleOperationOptions {
  /** Fee rate for Bitcoin operations (sat/vB) */
  feeRate?: number;
  
  /** Progress callback for operation updates */
  onProgress?: (progress: LifecycleProgress) => void;
  
  /** Enable atomic rollback on failure (default: true) */
  atomicRollback?: boolean;
}
```

### ProgressCallback

```typescript
type ProgressCallback = (progress: LifecycleProgress) => void;
```

---

## Bitcoin Types

### OrdinalsInscription

```typescript
interface OrdinalsInscription {
  /** Unique satoshi identifier */
  satoshi: string;
  
  /** Inscription identifier */
  inscriptionId: string;
  
  /** Inscribed content */
  content: Buffer;
  
  /** Content MIME type */
  contentType: string;
  
  /** Transaction ID containing the inscription */
  txid: string;
  
  /** Output index */
  vout: number;
  
  /** Block height (if confirmed) */
  blockHeight?: number;
}
```

### BitcoinTransaction

```typescript
interface BitcoinTransaction {
  /** Transaction ID */
  txid: string;
  
  /** Transaction inputs */
  vin: TransactionInput[];
  
  /** Transaction outputs */
  vout: TransactionOutput[];
  
  /** Fee in satoshis */
  fee: number;
  
  /** Block height (if confirmed) */
  blockHeight?: number;
  
  /** Number of confirmations */
  confirmations?: number;
}
```

### TransactionInput

```typescript
interface TransactionInput {
  /** Previous transaction ID */
  txid: string;
  
  /** Previous output index */
  vout: number;
  
  /** Script signature */
  scriptSig?: string;
  
  /** Witness data */
  witness?: string[];
}
```

### TransactionOutput

```typescript
interface TransactionOutput {
  /** Value in satoshis */
  value: number;
  
  /** Output script */
  scriptPubKey: string;
  
  /** Destination address */
  address?: string;
}
```

### Utxo

```typescript
interface Utxo {
  /** Transaction ID */
  txid: string;
  
  /** Output index */
  vout: number;
  
  /** Value in satoshis */
  value: number;
  
  /** Output script */
  scriptPubKey?: string;
  
  /** Owner address */
  address?: string;
  
  /** Inscriptions on this UTXO */
  inscriptions?: string[];
  
  /** Whether UTXO is locked */
  locked?: boolean;
}
```

### ResourceUtxo

```typescript
interface ResourceUtxo extends Utxo {
  /** True if this UTXO contains an inscription */
  hasResource?: boolean;
}
```

### Constants

```typescript
const DUST_LIMIT_SATS = 546;
```

---

## Event Types

### Base Event

```typescript
interface BaseEvent {
  type: string;
  timestamp: string;
}
```

### Asset Events

```typescript
interface AssetCreatedEvent extends BaseEvent {
  type: 'asset:created';
  asset: {
    id: string;
    layer: LayerType;
    resourceCount: number;
    createdAt: string;
  };
}

interface AssetMigratedEvent extends BaseEvent {
  type: 'asset:migrated';
  asset: {
    id: string;
    fromLayer: LayerType;
    toLayer: LayerType;
  };
  details?: {
    transactionId?: string;
    inscriptionId?: string;
    satoshi?: string;
    commitTxId?: string;
    revealTxId?: string;
    feeRate?: number;
  };
}

interface AssetTransferredEvent extends BaseEvent {
  type: 'asset:transferred';
  asset: {
    id: string;
    layer: LayerType;
  };
  from: string;
  to: string;
  transactionId: string;
}
```

### Resource Events

```typescript
interface ResourcePublishedEvent extends BaseEvent {
  type: 'resource:published';
  asset: { id: string };
  resource: {
    id: string;
    url: string;
    contentType: string;
    hash: string;
  };
  publisherDid: string;
}

interface ResourceVersionCreatedEvent extends BaseEvent {
  type: 'resource:version:created';
  asset: { id: string };
  resource: {
    id: string;
    fromVersion: number;
    toVersion: number;
    fromHash: string;
    toHash: string;
  };
  changes?: string;
}
```

### Batch Events

```typescript
interface BatchStartedEvent extends BaseEvent {
  type: 'batch:started';
  operation: 'create' | 'publish' | 'inscribe' | 'transfer';
  batchId: string;
  itemCount: number;
}

interface BatchCompletedEvent extends BaseEvent {
  type: 'batch:completed';
  batchId: string;
  operation: string;
  results: {
    successful: number;
    failed: number;
    totalDuration: number;
    costSavings?: {
      amount: number;
      percentage: number;
    };
  };
}

interface BatchFailedEvent extends BaseEvent {
  type: 'batch:failed';
  batchId: string;
  operation: string;
  error: string;
  partialResults?: {
    successful: number;
    failed: number;
  };
}

interface BatchProgressEvent extends BaseEvent {
  type: 'batch:progress';
  batchId: string;
  operation: string;
  progress: number;
  completed: number;
  failed: number;
  total: number;
}
```

### Event Handler

```typescript
type EventHandler<T extends OriginalsEvent = OriginalsEvent> = 
  (event: T) => void | Promise<void>;
```

### EventTypeMap

```typescript
interface EventTypeMap {
  'asset:created': AssetCreatedEvent;
  'asset:migrated': AssetMigratedEvent;
  'asset:transferred': AssetTransferredEvent;
  'resource:published': ResourcePublishedEvent;
  'resource:version:created': ResourceVersionCreatedEvent;
  'credential:issued': CredentialIssuedEvent;
  'verification:completed': VerificationCompletedEvent;
  'batch:started': BatchStartedEvent;
  'batch:completed': BatchCompletedEvent;
  'batch:failed': BatchFailedEvent;
  'batch:progress': BatchProgressEvent;
  // ... migration events
}
```

---

## Adapter Types

### StorageAdapter

```typescript
interface StorageAdapter {
  /** Store data */
  put(objectKey: string, data: Buffer | string, options?: StoragePutOptions): Promise<string>;
  
  /** Retrieve data */
  get(objectKey: string): Promise<StorageGetResult | null>;
  
  /** Delete data (optional) */
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

### FeeOracleAdapter

```typescript
interface FeeOracleAdapter {
  /** Estimate fee rate in sat/vB for target confirmation blocks */
  estimateFeeRate(targetBlocks?: number): Promise<number>;
}
```

### OrdinalsProvider

```typescript
interface OrdinalsProvider {
  /** Get inscription by ID */
  getInscriptionById(id: string): Promise<{
    inscriptionId: string;
    content: Buffer;
    contentType: string;
    txid: string;
    vout: number;
    satoshi?: string;
    blockHeight?: number;
  } | null>;
  
  /** Get inscriptions on a satoshi */
  getInscriptionsBySatoshi(satoshi: string): Promise<Array<{ inscriptionId: string }>>;
  
  /** Broadcast transaction */
  broadcastTransaction(txHexOrObj: unknown): Promise<string>;
  
  /** Get transaction confirmation status */
  getTransactionStatus(txid: string): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    confirmations?: number;
  }>;
  
  /** Estimate fee rate */
  estimateFee(blocks?: number): Promise<number>;
  
  /** Create inscription */
  createInscription(params: {
    data: Buffer;
    contentType: string;
    feeRate?: number;
  }): Promise<{
    inscriptionId: string;
    revealTxId: string;
    commitTxId?: string;
    satoshi?: string;
    txid?: string;
    vout?: number;
    blockHeight?: number;
    content?: Buffer;
    contentType?: string;
    feeRate?: number;
  }>;
  
  /** Transfer inscription */
  transferInscription(
    inscriptionId: string,
    toAddress: string,
    options?: { feeRate?: number }
  ): Promise<{
    txid: string;
    vin: Array<{ txid: string; vout: number }>;
    vout: Array<{ value: number; scriptPubKey: string; address?: string }>;
    fee: number;
    blockHeight?: number;
    confirmations?: number;
    satoshi?: string;
  }>;
}
```

### ExternalSigner

```typescript
interface ExternalSigner {
  /** Sign document with proof */
  sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }>;
  
  /** Get verification method identifier */
  getVerificationMethodId(): string | Promise<string>;
}
```

### ExternalVerifier

```typescript
interface ExternalVerifier {
  /** Verify signature */
  verify(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array
  ): Promise<boolean>;
}
```

---

## Network Types

### WebVH Networks

```typescript
type WebVHNetworkName = 'magby' | 'cleffa' | 'pichu';

type BitcoinNetworkName = 'mainnet' | 'regtest' | 'signet';

type VersionStability = 'patch' | 'minor' | 'major';

interface WebVHNetworkConfig {
  name: WebVHNetworkName;
  domain: string;
  stability: VersionStability;
  description: string;
  contextUrl: string;
  bitcoinNetwork: BitcoinNetworkName;
}
```

### Network Constants

```typescript
const WEBVH_NETWORKS: Record<WebVHNetworkName, WebVHNetworkConfig> = {
  magby: {
    name: 'magby',
    domain: 'magby.originals.build',
    stability: 'patch',
    description: 'Development network',
    contextUrl: 'https://magby.originals.build/context',
    bitcoinNetwork: 'regtest',
  },
  cleffa: {
    name: 'cleffa',
    domain: 'cleffa.originals.build',
    stability: 'minor',
    description: 'Staging network',
    contextUrl: 'https://cleffa.originals.build/context',
    bitcoinNetwork: 'signet',
  },
  pichu: {
    name: 'pichu',
    domain: 'pichu.originals.build',
    stability: 'major',
    description: 'Production network',
    contextUrl: 'https://pichu.originals.build/context',
    bitcoinNetwork: 'mainnet',
  },
};

const DEFAULT_WEBVH_NETWORK: WebVHNetworkName = 'pichu';
```

---

## Utility Types

### KeyType

```typescript
type KeyType = 'ES256K' | 'Ed25519' | 'ES256';
```

### MultikeyType

```typescript
type MultikeyType = 'Ed25519' | 'Secp256k1' | 'P256' | 'Bls12381G2';
```

### BatchOperationOptions

```typescript
interface BatchOperationOptions {
  /** Validate all items before execution (default: true) */
  validateFirst?: boolean;
  
  /** Continue processing after failures */
  continueOnError?: boolean;
  
  /** Maximum parallel operations */
  parallelism?: number;
}

interface BatchInscriptionOptions extends BatchOperationOptions {
  /** Combine into single transaction for cost savings */
  singleTransaction?: boolean;
  
  /** Fee rate in sat/vB */
  feeRate?: number;
}
```

### BatchResult

```typescript
interface BatchResult<T> {
  /** Successful operations */
  successful: Array<{
    index: number;
    result: T;
    duration: number;
  }>;
  
  /** Failed operations */
  failed: Array<{
    index: number;
    error: Error;
    duration: number;
  }>;
  
  /** Total items processed */
  totalProcessed: number;
  
  /** Total duration in ms */
  totalDuration: number;
  
  /** Batch identifier */
  batchId: string;
  
  /** ISO 8601 start time */
  startedAt: string;
  
  /** ISO 8601 completion time */
  completedAt: string;
}
```

### Validation Types

```typescript
interface SatoshiValidationResult {
  valid: boolean;
  error?: string;
}

// Constants
const MAX_SATOSHI_SUPPLY = 2_100_000_000_000_000; // 21M BTC * 100M sats
```




