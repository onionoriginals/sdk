# Originals Protocol - Technical Specification

**Version:** 1.0.0  
**Status:** Implementation Specification  
**Date:** 2025-09-30  

---

## Table of Contents

1. [Executive Overview](#1-executive-overview)
2. [Concepts & Requirements](#2-concepts--requirements)
3. [Architecture](#3-architecture)
4. [Component & API Specifications](#4-component--api-specifications)
5. [Data Models](#5-data-models)
6. [Data Flow & Workflows](#6-data-flow--workflows)
7. [Error Handling](#7-error-handling)
8. [Testing & Validation](#8-testing--validation)
9. [Security Considerations](#9-security-considerations)
10. [Implementation Assumptions](#10-implementation-assumptions)
11. [Open Questions](#11-open-questions)

---

## 1. Executive Overview

### 1.1 Purpose

The Originals Protocol provides a decentralized system for creating, discovering, and transferring digital assets with cryptographically verifiable provenance. It implements a three-layer architecture that separates concerns of creation, discovery, and ownership, allowing assets to migrate through layers based on economic value and security requirements.

### 1.2 Core Principles

1. **Economic Layer Separation**: Assets start in low-cost environments and migrate to Bitcoin only when value justifies security costs
2. **Unidirectional Migration**: Assets can only move forward through layers (peer → webvh → btco), never backward
3. **Cryptographic Provenance**: All transitions and ownership changes are cryptographically verifiable
4. **Standards Compliance**: Built on W3C DID and Verifiable Credentials standards
5. **Front-Running Prevention**: Bitcoin's ordinal theory ensures unique satoshi assignment prevents double-inscription attacks

### 1.3 Three-Layer Architecture

| Layer | Security | Cost | Economic Role | Method |
|-------|----------|------|---------------|--------|
| **did:peer** | High (self-contained) | $0 | None - Experimentation & Creation | DID Peer (numalgo4) |
| **did:webvh** | Medium (HTTPS) | ~$25/year | None - Public Discovery | DID WebVH |
| **did:btco** | Maximum (Bitcoin) | $75-200 one-time | All Transfers | Bitcoin Ordinals |

---

## 2. Concepts & Requirements

### 2.1 Decentralized Identifiers (DIDs)

#### 2.1.1 did:peer (Creation Layer)

**Purpose**: Private, offline creation and experimentation

**Specification**: 
- Based on DID Peer Method Specification (numalgo4 long-form variant)
- Self-contained: entire DID document encoded in the identifier
- No network lookups required
- Generated using `@aviarytech/did-peer` library

**Format**:
```
did:peer:4z...{long-form-encoding}
```

**Key Characteristics**:
- Free to create (no blockchain fees)
- Locally generated and stored
- Not publicly resolvable without the full DID string
- Supports multiple key types via Multikey
- Includes full DID Document in the identifier

**Requirements**:
- MUST support Ed25519, secp256k1, and P-256 keys
- MUST include at least one verification method
- MUST specify `authentication` and `assertionMethod` relationships
- SHOULD use Multikey verification method type

#### 2.1.2 did:webvh (Discovery Layer)

**Purpose**: Public discovery via HTTPS hosting

**Specification**:
- Based on DID WebVH Method (Web Verifiable History)
- Hosted at `https://{domain}/.well-known/webvh/{slug}/did.jsonl`
- Version history maintained via append-only log
- Uses `didwebvh-ts` library for implementation

**Format**:
```
did:webvh:{domain}:{slug}
```

**Key Characteristics**:
- Publicly discoverable via standard HTTPS
- Versioned history of DID document updates
- ~$25/year hosting cost
- Requires domain ownership
- Supports service endpoints for resource hosting

**Requirements**:
- Domain MUST be valid per RFC domain constraints
- Slug MUST be derived from original peer DID for stability
- Resources MUST be hosted at content-addressed paths under `.well-known/webvh/{slug}/resources/{multibase-hash}`
- Storage adapter MUST be pluggable (S3, local filesystem, etc.)

#### 2.1.3 did:btco (Ownership Layer)

**Purpose**: Transferable ownership on Bitcoin blockchain

**Specification**: Based on BTCO DID Method v0.2.0

**Format**:
```
did:btco:{satoshi-number}
did:btco:test:{satoshi-number}  # testnet
did:btco:sig:{satoshi-number}   # signet
```

**Key Characteristics**:
- Satoshi number MUST be valid integer between 0 and 2,099,999,997,689,999
- DID document stored as CBOR-encoded metadata in Bitcoin inscription
- Control tied to UTXO ownership
- $75-200 one-time inscription fee
- Immutable and permanent
- Ordinal theory prevents front-running

**Requirements**:
- DID Document MUST be stored in inscription metadata (not content)
- Inscription content MAY contain any valid data
- Most recent valid inscription is authoritative
- Deactivation indicated by `"deactivated": true` in metadata
- MUST support Multikey verification methods

**Resolution Process**:
1. Parse DID to extract satoshi number
2. Query ordinals indexer for inscriptions on satoshi
3. Retrieve most recent inscription with valid DID metadata
4. Decode CBOR metadata to get DID Document
5. Validate DID Document structure and ID match

### 2.2 BTCO DID Linked Resources

DID Linked Resources provide a standardized way to reference content inscribed on Bitcoin.

#### 2.2.1 Resource Identification

**Format**:
```
did:btco:{satoshi}/{index}              # Specific inscription
did:btco:{satoshi}/{index}/info         # Resource metadata
did:btco:{satoshi}/{index}/meta         # Verifiable Credential metadata (if present)
```

**Examples**:
```
did:btco:1954913028215432/0              # First inscription on satoshi
did:btco:1954913028215432/0/info         # Inscription info
did:btco:1954913028215432/0/meta         # VC metadata if available
```

#### 2.2.2 Resource Collections

**DID Collections** (Reinscriptions):
- All inscriptions on a single satoshi
- Format: `did:btco:{satoshi}`
- Ordered by inscription sequence

**Heritage Collections** (Parent/Child):
- Child inscriptions reference parent via transaction inclusion
- Format: `did:btco:{satoshi}/heritage`
- Child reference: `did:btco:{satoshi}/child/{index}`
- Parent reference: `did:btco:{child-satoshi}/parent/{index}`

**Controller Collections**:
- All resources held by the same Bitcoin address
- Format: `did:btco:{satoshi}/controller`
- Mutable based on ownership

**Curated Collections**:
- Explicit list defined in a Verifiable Credential
- Format: `did:btco:{satoshi}/{index}/meta`
- VC type: `CuratedCollectionCredential`

### 2.3 Verifiable Credentials

All credentials MUST conform to:
- W3C Verifiable Credentials Data Model 2.0
- Data Integrity proof format (no JWT)
- Multikey verification methods (no JWK)

#### 2.3.1 Core Credential Types

**ResourceMetadataCredential**:
- Describes properties of a specific inscription
- Required fields: `name`, `description`, `contentType`, `created`
- Subject ID uses indexed form: `did:btco:{satoshi}/{index}`

**CollectionCredential**:
- Defines authenticated collection of resources
- Required fields: `name`, `description`, `collectionType`, `resources[]`
- Collection types: `curated`, `heritage`

**VerifiableCollectible**:
- Verifies authenticity of individual collectible
- Required fields: `title`, `creator`, `creationDate`, `properties`
- MUST reference creator's DID
- Issuer MUST be creator or authorized by creator

**CuratedCollectionCredential**:
- Establishes curated collections
- Required fields: `name`, `description`, `items[]`
- At least one item MUST be present

#### 2.3.2 Proof Requirements

**Supported Cryptosuites**:
- **Recommended**: `eddsa-rdfc-2022` (Ed25519 with RDF canonicalization)
- Also supported: `ecdsa-jcs-2019`, `ecdsa-rdfc-2019`, `eddsa-jcs-2022`, `bbs-2023`

**Proof Format**:
```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "eddsa-rdfc-2022",
  "created": "2024-03-21T12:00:00Z",
  "verificationMethod": "did:btco:123456/0#key-1",
  "proofPurpose": "assertionMethod",
  "proofValue": "z5jxQLyq5DWRDCZKmNjjKLzZDwbPM..."
}
```

**Requirements**:
- Credentials MAY have single proof or array of proofs
- ALL proofs MUST verify successfully
- `verificationMethod` uses indexed form to identify inscription containing keys
- Issuer and subject IDs use non-indexed form for identity stability

### 2.4 Asset Lifecycle

#### 2.4.1 Digital Asset Structure

An **OriginalsAsset** represents a digital asset with:
- Unique identifier (DID)
- One or more resources (content with integrity hashes)
- DID Document
- Verifiable Credentials
- Current layer (peer/webvh/btco)
- Provenance chain

#### 2.4.2 Migration Rules

**Valid Transitions**:
- `did:peer` → `did:webvh` OR `did:btco`
- `did:webvh` → `did:btco`
- `did:btco` → (no further migration, only transfers)

**Invalid Transitions**:
- Any backward migration
- Direct transfer in peer or webvh layers

#### 2.4.3 Provenance Tracking

All assets maintain complete provenance including:
- Creation timestamp and creator DID
- All layer migrations with details
- All ownership transfers (btco layer only)
- Transaction IDs for on-chain operations

---

## 3. Architecture

### 3.1 System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      OriginalsSDK                            │
├─────────────────────────────────────────────────────────────┤
│  Facade & Orchestration Layer                                │
│  - Configuration management                                   │
│  - Component initialization                                   │
│  - Telemetry emission                                         │
└────────┬─────────────┬──────────────┬──────────────┬─────────┘
         │             │              │              │
    ┌────▼────┐   ┌───▼────┐   ┌─────▼─────┐  ┌────▼────┐
    │   DID   │   │   VC   │   │ Lifecycle │  │ Bitcoin │
    │ Manager │   │Manager │   │  Manager  │  │ Manager │
    └────┬────┘   └───┬────┘   └─────┬─────┘  └────┬────┘
         │            │              │             │
         ├─── Key    │              │             ├─── Ordinals
         │    Manager│              │             │    Client
         │           │              │             │
         └─── BTCO   └─── Issuer   └─── Originals└─── PSBT
              Resolver    Verifier      Asset         Builder
```

### 3.2 Layer Architecture

#### 3.2.1 Core Layer
- **OriginalsSDK**: Main entry point and dependency manager
- Configuration validation and defaults
- Telemetry hooks

#### 3.2.2 Manager Layer
- **DIDManager**: DID creation, migration, resolution
- **CredentialManager**: VC issuance and verification
- **LifecycleManager**: Asset lifecycle orchestration
- **BitcoinManager**: Bitcoin/Ordinals operations

#### 3.2.3 Utility Layer
- **KeyManager**: Cryptographic key generation
- **Multikey**: Key encoding/decoding
- **Signer**: Cryptographic signing (Ed25519, secp256k1, P-256)
- **Validation**: DID and VC validation utilities
- **Serialization**: JSON-LD canonicalization

#### 3.2.4 Adapter Layer
- **StorageAdapter**: Pluggable storage for webvh resources
- **FeeOracleAdapter**: Bitcoin fee estimation
- **OrdinalsProvider**: Bitcoin inscription operations

### 3.3 Dependencies

**External Libraries**:
- `@aviarytech/did-peer`: DID Peer implementation
- `didwebvh-ts`: DID WebVH implementation
- `@noble/curves`, `@noble/hashes`: Cryptographic primitives
- `bitcoinjs-lib`: Bitcoin transaction building
- `cbor-js`: CBOR encoding/decoding
- `jsonld`: JSON-LD processing
- `multiformats`: Multibase/multicodec support

---

## 4. Component & API Specifications

### 4.1 OriginalsSDK

**Purpose**: Main SDK entry point providing unified interface

**Constructor**:
```typescript
constructor(config: OriginalsConfig)
```

**Static Factory**:
```typescript
static create(config?: Partial<OriginalsConfig>): OriginalsSDK
```

**Properties**:
- `did: DIDManager` - DID operations
- `credentials: CredentialManager` - VC operations
- `lifecycle: LifecycleManager` - Asset lifecycle
- `bitcoin: BitcoinManager` - Bitcoin operations

**Configuration**:
```typescript
interface OriginalsConfig {
  network: 'mainnet' | 'testnet' | 'regtest'
  bitcoinRpcUrl?: string
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256'
  enableLogging?: boolean
  storageAdapter?: StorageAdapter
  feeOracle?: FeeOracleAdapter
  ordinalsProvider?: OrdinalsProvider
  telemetry?: TelemetryHooks
}
```

**Default Configuration**:
```typescript
{
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  enableLogging: false
}
```

### 4.2 DIDManager

**Purpose**: Create, migrate, and resolve DIDs across all three layers

#### 4.2.1 Methods

**createDIDPeer**:
```typescript
async createDIDPeer(resources: AssetResource[]): Promise<DIDDocument>
```
- Generates keypair based on `defaultKeyType`
- Falls back to Ed25519 if ES256 specified (not yet supported)
- Uses `@aviarytech/did-peer` numalgo4
- Returns fully resolved DID Document with controller set

**migrateToDIDWebVH**:
```typescript
async migrateToDIDWebVH(didDoc: DIDDocument, domain: string): Promise<DIDDocument>
```
- Validates domain per RFC constraints (labels, length)
- Derives stable slug from original peer DID
- Constructs did:webvh:{domain}:{slug}
- Preserves verification methods from source

**Constraints**:
- Domain MUST match regex: `^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+?$`

**migrateToDIDBTCO**:
```typescript
async migrateToDIDBTCO(didDoc: DIDDocument, satoshi: string): Promise<DIDDocument>
```
- Validates satoshi is numeric string
- Attempts to preserve first Multikey verification method
- Calls `createBtcoDidDocument` with key material if available
- Returns minimal DID doc if no keys present
- Preserves service endpoints from source

**resolveDID**:
```typescript
async resolveDID(did: string): Promise<DIDDocument | null>
```
- Routes to appropriate resolver based on method
- `did:peer` → `@aviarytech/did-peer.resolve()`
- `did:webvh` → `didwebvh-ts.resolveDID()`
- `did:btco*` → `BtcoDidResolver.resolve()`
- Returns minimal document if resolution fails

**createBtcoDidDocument**:
```typescript
createBtcoDidDocument(
  satNumber: number | string,
  network: 'mainnet' | 'testnet' | 'signet',
  options: { publicKey: Uint8Array; keyType: MultikeyType }
): DIDDocument
```
- Constructs proper prefix for network
- Builds verification method with fragment `#0`
- Sets authentication and assertionMethod relationships

### 4.3 CredentialManager

**Purpose**: Issue and verify Verifiable Credentials

#### 4.3.1 Methods

**createResourceCredential**:
```typescript
async createResourceCredential(
  type: 'ResourceCreated' | 'ResourceUpdated' | 'ResourceMigrated',
  subject: CredentialSubject,
  issuer: string
): Promise<VerifiableCredential>
```
- Creates unsigned credential with V1 context
- Sets issuanceDate to current timestamp
- Returns credential ready for signing

**signCredential**:
```typescript
async signCredential(
  credential: VerifiableCredential,
  privateKeyMultibase: string,
  verificationMethod: string
): Promise<VerifiableCredential>
```
- Attempts modern Issuer-based signing if DIDManager present
- Falls back to legacy DataIntegrityProof signing
- Canonicalizes credential and proof
- Generates proofValue via configured signer
- Returns credential with proof attached

**verifyCredential**:
```typescript
async verifyCredential(credential: VerifiableCredential): Promise<boolean>
```
- Detects cryptosuite-based proofs and uses Verifier
- Falls back to legacy verification
- Validates proof structure
- Resolves verification method from DID
- Canonicalizes and hashes credential + proof
- Verifies signature using resolved public key

**createPresentation**:
```typescript
async createPresentation(
  credentials: VerifiableCredential[],
  holder: string
): Promise<VerifiablePresentation>
```
- Wraps credentials in VP structure
- Sets holder DID
- Returns unsigned presentation

### 4.4 LifecycleManager

**Purpose**: Orchestrate asset creation and layer migrations

#### 4.4.1 Methods

**createAsset**:
```typescript
async createAsset(resources: AssetResource[]): Promise<OriginalsAsset>
```
- Creates minimal did:peer DID document
- Instantiates OriginalsAsset
- Sets currentLayer to 'did:peer'
- Initializes empty provenance chain

**publishToWeb**:
```typescript
async publishToWeb(asset: OriginalsAsset, domain: string): Promise<OriginalsAsset>
```
- MUST be called only on peer-layer assets
- Generates slug from asset ID
- Publishes resources to storage adapter at content-addressed paths
- Path format: `.well-known/webvh/{slug}/resources/{multibase-hash}`
- Constructs did:webvh identifier
- Calls `asset.migrate('did:webvh')`
- Issues ResourceMigrated credential (best-effort)
- Updates asset bindings with webvh DID

**inscribeOnBitcoin**:
```typescript
async inscribeOnBitcoin(asset: OriginalsAsset, feeRate?: number): Promise<OriginalsAsset>
```
- MUST be called only on peer or webvh layer assets
- Creates manifest with assetId, resources, timestamp
- Calls `BitcoinManager.inscribeData()` with manifest
- Extracts satoshi, inscription ID, transaction details
- Calls `asset.migrate('did:btco')` with full details
- Constructs did:btco identifier from satoshi
- Updates asset bindings with btco DID

**transferOwnership**:
```typescript
async transferOwnership(asset: OriginalsAsset, newOwner: string): Promise<BitcoinTransaction>
```
- MUST be called only on btco-layer assets
- Extracts satoshi from provenance
- Calls `BitcoinManager.transferInscription()`
- Records transfer in asset provenance
- Returns transaction details

### 4.5 BitcoinManager

**Purpose**: Handle Bitcoin inscription and transfer operations

#### 4.5.1 Methods

**inscribeData**:
```typescript
async inscribeData(
  data: Buffer,
  contentType: string,
  feeRate?: number
): Promise<OrdinalsInscription>
```
- Resolves fee rate via fee oracle, ordinals provider, or provided value
- Delegates to configured OrdinalsProvider if present
- Returns mock inscription if no provider configured
- Retrieves satoshi from inscription if not provided
- Records feeRate in response for provenance

**trackInscription**:
```typescript
async trackInscription(inscriptionId: string): Promise<OrdinalsInscription | null>
```
- Queries ordinals provider for inscription by ID
- Returns null if not found or no provider

**transferInscription**:
```typescript
async transferInscription(
  inscription: OrdinalsInscription,
  toAddress: string
): Promise<BitcoinTransaction>
```
- Resolves fee rate
- Delegates to ordinals provider
- Returns mock transaction if no provider
- Updates inscription satoshi if changed
- Returns transaction with vin/vout details

**preventFrontRunning**:
```typescript
async preventFrontRunning(satoshi: string): Promise<boolean>
```
- Checks if satoshi has only one inscription
- Bitcoin's ordinal theory ensures first inscription wins
- Returns true if safe (≤1 inscription)

**validateBTCODID**:
```typescript
async validateBTCODID(didId: string): Promise<boolean>
```
- Extracts satoshi from did:btco DID
- Queries for inscriptions on satoshi
- Returns true if any inscriptions exist

### 4.6 BtcoDidResolver

**Purpose**: Resolve did:btco DIDs from Bitcoin inscriptions

**Constructor**:
```typescript
constructor(options: BtcoDidResolutionOptions = {})
```

**resolve**:
```typescript
async resolve(did: string, options?: BtcoDidResolutionOptions): Promise<BtcoDidResolutionResult>
```

**Resolution Algorithm**:
1. Parse DID: `did:btco:[network]:satNumber[/path]`
2. Query provider for satoshi inscription IDs
3. For each inscription (newest to oldest):
   - Fetch inscription content via content URL
   - Fetch inscription metadata (CBOR-encoded)
   - Check for valid DID marker in content
   - Validate DID Document in metadata
   - Check for deactivation (🔥 in content - legacy)
4. Return most recent valid DID Document

**Error Codes**:
- `invalidDid`: Malformed DID format
- `noProvider`: No resource provider supplied
- `notFound`: No inscriptions on satoshi or fetch failed

**Result Structure**:
```typescript
{
  didDocument: DIDDocument | null,
  inscriptions: BtcoInscriptionData[],
  resolutionMetadata: {
    inscriptionId?: string,
    satNumber?: string,
    network?: string,
    totalInscriptions?: number,
    error?: string,
    message?: string
  },
  didDocumentMetadata: {
    created?: string,
    updated?: string,
    deactivated?: boolean,
    inscriptionId?: string,
    network?: string
  }
}
```

### 4.7 OriginalsAsset

**Purpose**: Represent a digital asset through its lifecycle

**Constructor**:
```typescript
constructor(
  resources: AssetResource[],
  did: DIDDocument,
  credentials: VerifiableCredential[]
)
```

**Properties**:
- `id: string` - DID of the asset
- `resources: AssetResource[]` - Content resources
- `did: DIDDocument` - Current DID Document
- `credentials: VerifiableCredential[]` - Associated VCs
- `currentLayer: LayerType` - Current migration layer
- `bindings?: Record<string, string>` - Layer-specific DID mappings

**Methods**:

**migrate**:
```typescript
async migrate(
  toLayer: LayerType,
  details?: MigrationDetails
): Promise<void>
```
- Validates transition is allowed
- Records migration in provenance
- Updates currentLayer
- Updates txid if provided

**getProvenance**:
```typescript
getProvenance(): ProvenanceChain
```
- Returns complete provenance history

**recordTransfer**:
```typescript
recordTransfer(from: string, to: string, transactionId: string): void
```
- Records ownership transfer (btco only)
- Updates provenance txid

**verify**:
```typescript
async verify(deps?: VerifyDeps): Promise<boolean>
```
- Validates DID Document structure
- Verifies resource integrity (hashes match content)
- Validates all credential structures
- Optionally performs cryptographic verification if CredentialManager provided
- Returns false if any check fails

**Verification Algorithm**:
1. Validate DID Document structure via `validateDIDDocument()`
2. For each resource:
   - Check required fields (id, type, contentType, hash)
   - If `content` present: hash and compare to declared hash
   - If `url` present and fetch provided: fetch, hash, compare
3. Validate each credential structure via `validateCredential()`
4. If CredentialManager provided: cryptographically verify each credential
5. Return true only if all checks pass

---

## 5. Data Models

### 5.1 Core Types

**AssetResource**:
```typescript
interface AssetResource {
  id: string                // Resource identifier
  type: string              // 'image', 'text', 'code', 'data', etc.
  url?: string              // Optional URL for hosted content
  content?: string          // Optional inline content
  contentType: string       // MIME type
  hash: string              // SHA-256 hash (hex-encoded)
  size?: number             // Size in bytes
}
```

**DIDDocument** (W3C DID Core):
```typescript
interface DIDDocument {
  '@context': string[]
  id: string
  verificationMethod?: VerificationMethod[]
  authentication?: (string | VerificationMethod)[]
  assertionMethod?: (string | VerificationMethod)[]
  keyAgreement?: (string | VerificationMethod)[]
  capabilityInvocation?: (string | VerificationMethod)[]
  capabilityDelegation?: (string | VerificationMethod)[]
  service?: ServiceEndpoint[]
  controller?: string[]
  alsoKnownAs?: string[]
}
```

**VerificationMethod**:
```typescript
interface VerificationMethod {
  id: string                  // e.g., "did:btco:123#0"
  type: string                // "Multikey"
  controller: string          // DID of controller
  publicKeyMultibase: string  // Multibase-encoded key
}
```

**VerifiableCredential** (W3C VC Data Model 2.0):
```typescript
interface VerifiableCredential {
  '@context': string[]
  type: string[]
  id?: string
  issuer: string | Issuer
  issuanceDate: string        // ISO 8601
  expirationDate?: string
  credentialSubject: CredentialSubject
  credentialStatus?: CredentialStatus
  proof?: Proof | Proof[]
}
```

**Proof** (Data Integrity):
```typescript
interface Proof {
  type: string                // "DataIntegrityProof"
  created: string             // ISO 8601
  verificationMethod: string  // DID URL to key
  proofPurpose: string        // "assertionMethod" | "authentication"
  proofValue: string          // Multibase-encoded signature
  cryptosuite?: string        // e.g., "eddsa-rdfc-2022"
}
```

**ProvenanceChain**:
```typescript
interface ProvenanceChain {
  createdAt: string
  creator: string             // Creator DID
  txid?: string               // Latest transaction ID
  migrations: Migration[]
  transfers: Transfer[]
}

interface Migration {
  from: LayerType
  to: LayerType
  timestamp: string           // ISO 8601
  transactionId?: string
  inscriptionId?: string
  satoshi?: string
  commitTxId?: string
  revealTxId?: string
  feeRate?: number
}

interface Transfer {
  from: string                // Sender address/DID
  to: string                  // Receiver address/DID
  timestamp: string
  transactionId: string
}
```

### 5.2 Bitcoin Types

**OrdinalsInscription**:
```typescript
interface OrdinalsInscription {
  satoshi: string             // Ordinal number
  inscriptionId: string       // Inscription identifier
  content: Buffer             // Raw inscription data
  contentType: string         // MIME type
  txid: string                // Transaction ID
  vout: number                // Output index
  blockHeight?: number        // Block height of confirmation
}
```

**BitcoinTransaction**:
```typescript
interface BitcoinTransaction {
  txid: string
  vin: TransactionInput[]
  vout: TransactionOutput[]
  fee: number                 // Satoshis
  blockHeight?: number
  confirmations?: number
}
```

**Utxo**:
```typescript
interface Utxo {
  txid: string
  vout: number
  value: number               // Satoshis
  scriptPubKey?: string
  address?: string
  inscriptions?: string[]     // Inscription IDs on this UTXO
  locked?: boolean            // Wallet lock status
}
```

### 5.3 Cryptographic Types

**KeyPair**:
```typescript
interface KeyPair {
  privateKey: string          // Multibase-encoded
  publicKey: string           // Multibase-encoded
}

type KeyType = 'ES256K' | 'Ed25519' | 'ES256'
type MultikeyType = 'Ed25519' | 'Secp256k1' | 'Bls12381G2' | 'P256'
```

**Multicodec Headers**:
- Ed25519 public: `[0xed, 0x01]`
- Ed25519 private: `[0x80, 0x26]`
- secp256k1 public: `[0xe7, 0x01]`
- secp256k1 private: `[0x13, 0x01]`
- P-256 public: `[0x80, 0x24]`
- P-256 private: `[0x81, 0x26]`
- BLS12-381 G2 public: `[0xeb, 0x01]`
- BLS12-381 G2 private: `[0x82, 0x26]`

---

## 6. Data Flow & Workflows

### 6.1 Asset Creation Workflow

```
User Request
    ↓
LifecycleManager.createAsset(resources[])
    ↓
DIDManager.createDIDPeer()
    ├→ KeyManager.generateKeyPair()
    └→ @aviarytech/did-peer.createNumAlgo4()
    ↓
new OriginalsAsset(resources, didDoc, [])
    ├→ determineCurrentLayer() → 'did:peer'
    └→ initialize provenance chain
    ↓
return OriginalsAsset
```

**Inputs**:
- Array of `AssetResource` with id, type, contentType, hash

**Outputs**:
- `OriginalsAsset` in did:peer layer

**Side Effects**:
- Keypair generated
- Telemetry event emitted

### 6.2 Web Publishing Workflow

```
User Request: publishToWeb(asset, domain)
    ↓
Validate: asset.currentLayer === 'did:peer'
    ↓
Generate slug from asset.id
    ↓
For each resource:
    ├→ Compute multibase hash
    ├→ Upload to storage adapter at .well-known/webvh/{slug}/resources/{hash}
    └→ Update resource.url
    ↓
Construct did:webvh:{domain}:{slug}
    ↓
asset.migrate('did:webvh')
    ├→ Record migration in provenance
    └→ Update currentLayer
    ↓
Issue ResourceMigrated credential (best-effort)
    ├→ CredentialManager.createResourceCredential()
    ├→ KeyManager.generateKeyPair()
    └→ CredentialManager.signCredential()
    ↓
Update asset.bindings['did:webvh']
    ↓
return updated asset
```

**Inputs**:
- `OriginalsAsset` in did:peer layer
- Valid domain string

**Outputs**:
- `OriginalsAsset` in did:webvh layer
- Resources uploaded to storage

**Side Effects**:
- Resources written to configured StorageAdapter
- Provenance chain updated
- Optional credential issued

**Errors**:
- Throws if currentLayer !== 'did:peer'
- Throws if domain invalid
- Storage adapter errors propagated

### 6.3 Bitcoin Inscription Workflow

```
User Request: inscribeOnBitcoin(asset, feeRate?)
    ↓
Validate: asset.currentLayer in ['did:peer', 'did:webvh']
    ↓
Create manifest JSON:
    {
      assetId,
      resources: [{id, hash, contentType, url}],
      timestamp
    }
    ↓
BitcoinManager.inscribeData(manifest, 'application/json', feeRate)
    ↓
    ├→ Resolve fee rate (oracle → provider → specified)
    ├→ OrdinalsProvider.createInscription()
    │   ├→ Build commit transaction
    │   ├→ Build reveal transaction
    │   └→ Broadcast both
    └→ Get satoshi from inscription ID if not provided
    ↓
Extract: revealTxId, commitTxId, inscriptionId, satoshi, feeRate
    ↓
asset.migrate('did:btco', {transactionId, inscriptionId, satoshi, ...})
    ├→ Validate transition
    ├→ Record in provenance
    └→ Update currentLayer
    ↓
Construct did:btco:{satoshi}
    ↓
Update asset.bindings['did:btco']
    ↓
return updated asset
```

**Inputs**:
- `OriginalsAsset` in did:peer or did:webvh layer
- Optional fee rate in sat/vB

**Outputs**:
- `OriginalsAsset` in did:btco layer
- Bitcoin transactions broadcast

**Side Effects**:
- Commit and reveal transactions submitted to Bitcoin network
- Inscription created on-chain
- Provenance updated with full transaction details

**Costs**:
- Commit transaction fee
- Reveal transaction fee (depends on inscription size)
- Typical range: $75-200 USD

### 6.4 Ownership Transfer Workflow

```
User Request: transferOwnership(asset, newOwnerAddress)
    ↓
Validate: asset.currentLayer === 'did:btco'
    ↓
Extract satoshi from provenance.migrations[-1]
    ↓
Construct inscription object from provenance
    ↓
BitcoinManager.transferInscription(inscription, newOwnerAddress)
    ↓
    ├→ Resolve fee rate
    ├→ OrdinalsProvider.transferInscription()
    │   ├→ Build transaction spending inscription UTXO
    │   ├→ Send to newOwnerAddress
    │   └→ Broadcast
    └→ Update inscription.satoshi if changed
    ↓
asset.recordTransfer(asset.id, newOwnerAddress, txid)
    ├→ Add to provenance.transfers
    └→ Update provenance.txid
    ↓
return BitcoinTransaction
```

**Inputs**:
- `OriginalsAsset` in did:btco layer
- Valid Bitcoin address

**Outputs**:
- `BitcoinTransaction` with transfer details

**Side Effects**:
- Bitcoin transaction broadcast
- Ownership transferred on-chain
- Provenance updated

**Errors**:
- Throws if currentLayer !== 'did:btco'
- Provider errors propagated

### 6.5 DID Resolution Workflow (did:btco)

```
User Request: resolveDID('did:btco:123456')
    ↓
BtcoDidResolver.resolve()
    ↓
Parse DID → extract satoshi number & network
    ↓
Provider.getSatInfo(satoshi)
    ↓
Receive inscription_ids[] (oldest to newest)
    ↓
For each inscriptionId (iterate newest first):
    ├→ Provider.resolveInscription(inscriptionId)
    ├→ Fetch content via content_url
    ├→ Check content for DID marker pattern
    ├→ Provider.getMetadata(inscriptionId)
    ├→ Decode CBOR metadata
    ├→ Validate as DID Document
    ├→ Check for deactivation
    └→ If valid: mark as candidate
    ↓
Return most recent valid DID Document
    ↓
Include all inscriptions in result for history
```

**Inputs**:
- DID string: `did:btco:{network}:{satoshi}`

**Outputs**:
- `BtcoDidResolutionResult` with DID Document and metadata

**Caching**:
- DID resolution results SHOULD be cached
- Cache invalidation on new inscriptions or block reorgs

### 6.6 Credential Verification Workflow

```
User Request: verifyCredential(credential)
    ↓
Detect proof type (cryptosuite present?)
    ↓
IF cryptosuite-based:
    Verifier.verifyCredential()
        ├→ Validate structure
        ├→ Load contexts via documentLoader
        ├→ Extract proof
        ├→ DataIntegrityProofManager.verifyProof()
        │   ├→ Resolve verificationMethod DID
        │   ├→ Get public key
        │   ├→ Canonicalize credential + proof
        │   ├→ Hash with cryptosuite algorithm
        │   └→ Verify signature
        └→ Return {verified: boolean, errors: string[]}
ELSE:
    Legacy verification:
        ├→ Extract proof
        ├→ Resolve verificationMethod to publicKeyMultibase
        ├→ Canonicalize credential and proof separately
        ├→ Hash both: h(proof) + h(credential)
        ├→ Decode proofValue
        ├→ Verify signature with resolved key
        └→ Return boolean
```

**Inputs**:
- `VerifiableCredential` with proof

**Outputs**:
- Boolean or `VerificationResult`

**Requirements**:
- ALL proofs must verify if multiple present
- Verification method MUST resolve successfully
- Signature MUST be valid

---

## 7. Error Handling

### 7.1 Error Categories

#### 7.1.1 Configuration Errors
- Invalid network specified
- Invalid defaultKeyType
- Missing required adapters for operation

**Handling**: Throw synchronously at SDK initialization

#### 7.1.2 Validation Errors
- Invalid DID format
- Invalid domain format
- Invalid satoshi number
- Invalid migration transition

**Handling**: Throw with descriptive message

#### 7.1.3 Network Errors
- Bitcoin RPC unreachable
- Ordinals indexer down
- Storage adapter failure

**Handling**: Propagate with context via StructuredError

#### 7.1.4 Cryptographic Errors
- Invalid key format
- Signature verification failure
- Unsupported cryptosuite

**Handling**: Return false from verification methods; throw from signing

### 7.2 StructuredError Format

```typescript
class StructuredError extends Error {
  constructor(
    public code: string,
    message: string,
    public context?: Record<string, unknown>
  )
}
```

**Common Error Codes**:
- `INVALID_DID_FORMAT`
- `INVALID_TRANSITION`
- `ORD_PROVIDER_UNSUPPORTED`
- `ORD_PROVIDER_INVALID_RESPONSE`
- `SATOSHI_REQUIRED`
- `MISSING_PROVIDER`
- `VERIFICATION_FAILED`

### 7.3 Telemetry Integration

All errors SHOULD be emitted via telemetry hooks:

```typescript
telemetry.onError({
  code: 'ERROR_CODE',
  message: 'Human-readable message',
  attributes: { context }
})
```

### 7.4 Graceful Degradation

**Storage Failures**: Best-effort upload; continue if credential issuance fails

**Fee Oracle Failures**: Fallback chain:
1. Fee oracle adapter
2. Ordinals provider estimate
3. User-provided fee rate
4. Fail with clear error

**Resolution Failures**: Return minimal DID Document rather than null

---

## 8. Testing & Validation

### 8.1 Unit Test Requirements

#### 8.1.1 DID Operations
- ✅ Create did:peer with all supported key types
- ✅ Migrate peer → webvh with valid domain
- ✅ Reject invalid domain formats
- ✅ Migrate webvh → btco with valid satoshi
- ✅ Migrate peer → btco directly
- ✅ Reject backward migrations
- ✅ Resolve did:peer
- ✅ Resolve did:webvh (mocked)
- ✅ Resolve did:btco via BtcoDidResolver

#### 8.1.2 Credential Operations
- ✅ Create unsigned credentials
- ✅ Sign credentials with all key types
- ✅ Verify valid signatures
- ✅ Reject invalid signatures
- ✅ Reject tampered credentials
- ✅ Create presentations
- ✅ Verify presentations

#### 8.1.3 Lifecycle Operations
- ✅ Create asset in peer layer
- ✅ Publish to web updates layer and provenance
- ✅ Inscribe on Bitcoin updates layer and provenance
- ✅ Transfer ownership only in btco layer
- ✅ Reject invalid transitions
- ✅ Verify assets with valid hashes
- ✅ Reject assets with invalid hashes

#### 8.1.4 Bitcoin Operations
- ✅ Inscribe data (mocked and with provider)
- ✅ Track inscriptions
- ✅ Transfer inscriptions
- ✅ Prevent front-running check
- ✅ Validate BTCO DIDs
- ✅ Fee resolution fallback chain

### 8.2 Integration Test Requirements

#### 8.2.1 End-to-End Workflows
- Create asset → publish → inscribe → transfer
- Verify asset at each layer
- Resolve DIDs at each layer
- Full provenance tracking

#### 8.2.2 Provider Integration
- Real OrdinalsProvider operations (if available)
- Storage adapter integration
- Fee oracle integration

### 8.3 Validation Test Vectors

#### 8.3.1 Valid DIDs
```
did:peer:4zQmQKvr3jPdQYvMgcB2F7G9zZeHvFwPDrQw1xM3sKdWqJYZ
did:webvh:example.com:asset-123
did:btco:1066296127976657
did:btco:test:100000000
did:btco:sig:50000000
```

#### 8.3.2 Invalid DIDs
```
did:btco:-1                          # Negative satoshi
did:btco:2099999997690000           # Exceeds max satoshi
did:btco:abc123                     # Non-numeric
did:btco:1.5                        # Not integer
did:unknown:something               # Unsupported method
```

#### 8.3.3 Valid Credentials
See test suite for full examples with valid signatures

#### 8.3.4 Invalid Credentials
- Missing required fields
- Invalid contexts
- Expired credentials
- Invalid signatures
- Tampered proofValue

### 8.4 Performance Benchmarks

**Target Performance**:
- Create asset: < 100ms
- Sign credential: < 50ms
- Verify credential: < 100ms
- Resolve DID (cached): < 10ms
- Resolve DID (cold): < 500ms (network dependent)

### 8.5 Security Tests

- Key generation randomness
- Signature non-malleability
- Front-running prevention (satoshi uniqueness)
- DID document validation
- Credential proof verification
- Metadata tampering detection

---

## 9. Security Considerations

### 9.1 Key Management

**Requirements**:
- Private keys MUST be stored securely
- Keys MUST be generated using cryptographically secure random number generator
- Keys SHOULD be stored in hardware security modules (HSM) for production
- Private keys MUST NEVER be transmitted over network
- Private keys MUST NEVER be included in inscriptions

**Rotation**:
- did:peer keys: regenerate new DID
- did:webvh keys: update DID Document via log
- did:btco keys: reinscribe with new verification methods

### 9.2 Bitcoin-Specific Security

#### 9.2.1 Front-Running Protection
Bitcoin's ordinal theory ensures:
- Each satoshi has unique ordinal number
- First inscription on satoshi wins
- No double-spending of inscription slot

**Validation**:
- MUST check `preventFrontRunning()` before critical operations
- SHOULD verify only one inscription exists on target satoshi

#### 9.2.2 Transaction Security
- Always verify fee rate before broadcast
- Wait for confirmations (recommended: 6 blocks for high-value)
- Monitor for chain reorganizations
- Validate inscription is in confirmed block

#### 9.2.3 UTXO Management
- Track inscription locations
- Avoid spending inscription UTXOs accidentally
- Use UTXO locking when available

### 9.3 DID Security

#### 9.3.1 DID Document Integrity
- Validate all required fields present
- Check @context includes W3C DID v1
- Verify verification methods match expected format
- Validate controller relationship

#### 9.3.2 DID Resolution Security
- Cache resolution results with TTL
- Validate resolved document ID matches requested DID
- Check for deactivation status
- Verify inscription ordering for btco DIDs

### 9.4 Credential Security

#### 9.4.1 Issuance
- Verify issuer controls the DID
- Include expiration dates for time-sensitive credentials
- Use appropriate proofPurpose
- Sign with proper verification method relationship

#### 9.4.2 Verification
- ALWAYS verify cryptographic proofs
- Check credential not expired
- Verify issuer DID resolves successfully
- Validate all required fields present
- Check credential status if provided

#### 9.4.3 Presentation Security
- Verify holder matches expected entity
- Check challenge and domain if provided
- Verify all embedded credentials
- Validate presentation proof independently

### 9.5 Privacy Considerations

#### 9.5.1 Data Minimization
- SHOULD NOT include PII in on-chain data
- SHOULD use content hashes instead of full content
- MAY use encrypted content with off-chain decryption keys

#### 9.5.2 Correlation Resistance
- Use separate DIDs for different contexts when privacy required
- Consider timing analysis risks
- Be aware all Bitcoin transactions are public

#### 9.5.3 Metadata Leakage
- Inscription content types are public
- Transaction patterns may reveal usage
- Domain names in webvh DIDs are public

### 9.6 Network Security

#### 9.6.1 Provider Trust
- Verify OrdinalsProvider responses
- Use multiple providers for critical operations
- Implement provider health checks
- Monitor for provider compromise

#### 9.6.2 HTTPS Requirements
- did:webvh MUST use HTTPS
- Storage adapters SHOULD use TLS
- RPC endpoints SHOULD use TLS

### 9.7 Known Limitations

1. **did:webvh centralization**: Relies on DNS and HTTPS infrastructure
2. **Bitcoin finality**: Requires confirmation time (~10 minutes per block)
3. **Fee volatility**: Bitcoin fees can spike unpredictably
4. **Inscription permanence**: Cannot delete inscriptions
5. **Key compromise**: Lost Bitcoin keys = lost DID control
6. **DNS attacks**: did:webvh vulnerable to DNS hijacking

---

## 10. Implementation Assumptions

### 10.1 External Dependencies

#### 10.1.1 Bitcoin Network
- **Assumption**: Bitcoin network is operational and accessible
- **Assumption**: Ordinals protocol is stable and widely supported
- **Fallback**: Use testnet/signet for development

#### 10.1.2 Ordinals Indexer
- **Assumption**: Ord or compatible indexer available via HTTP API
- **Assumption**: Recursive endpoints supported for resource resolution
- **Fallback**: Mock provider for testing

#### 10.1.3 Storage Infrastructure
- **Assumption**: Reliable storage available for webvh resources
- **Assumption**: Content-addressed storage preferred
- **Fallback**: Local filesystem for development

### 10.2 Cryptographic Assumptions

#### 10.2.1 Signature Algorithms
- **Assumption**: Ed25519 provides 128-bit security
- **Assumption**: secp256k1 provides ~128-bit security
- **Assumption**: P-256 provides ~128-bit security
- **Justified by**: Industry-standard cryptographic algorithms

#### 10.2.2 Hash Functions
- **Assumption**: SHA-256 is collision-resistant
- **Justified by**: No known practical collisions

#### 10.2.3 Multibase/Multicodec
- **Assumption**: Multibase encodings are stable
- **Assumption**: Multicodec registries won't change
- **Justified by**: IPFS and DIF standardization

### 10.3 Protocol Assumptions

#### 10.3.1 W3C Standards
- **Assumption**: W3C DID Core v1 remains stable
- **Assumption**: VC Data Model 2.0 backward compatible with v1
- **Justified by**: W3C standardization process

#### 10.3.2 DID Methods
- **Assumption**: did:peer numalgo4 stable
- **Assumption**: did:webvh continues development
- **Assumption**: did:btco spec followed by indexers

#### 10.3.3 Bitcoin Ordinals
- **Assumption**: Ordinals protocol gains wider adoption
- **Assumption**: Inscription format remains stable
- **Assumption**: CBOR metadata support continues

### 10.4 Implementation Choices

#### 10.4.1 Default Key Type
- **Chosen**: ES256K (secp256k1) for Bitcoin compatibility
- **Rationale**: Native Bitcoin curve, widely supported
- **Alternative**: Ed25519 (better security margin, faster)

#### 10.4.2 Canonicalization
- **Chosen**: RDF Dataset Canonicalization (RDFC) for Data Integrity
- **Rationale**: W3C standard, deterministic
- **Alternative**: JCS (JSON Canonicalization Scheme) - simpler but less expressive

#### 10.4.3 Proof Format
- **Chosen**: Data Integrity Proofs (no JWT)
- **Rationale**: More flexible, better for JSON-LD
- **Alternative**: JWT proofs - simpler but less extensible

#### 10.4.4 Storage Model
- **Chosen**: Pluggable storage adapter
- **Rationale**: Allows cloud or local storage
- **Implementation**: S3-compatible or local filesystem

### 10.5 Unimplemented Features

The following features are specified but not fully implemented:

#### 10.5.1 ES256 Key Support
- **Status**: Specified in config, not supported by KeyManager
- **Workaround**: Falls back to Ed25519
- **TODO**: Implement P-256 key generation in KeyManager

#### 10.5.2 Credential Status Lists
- **Status**: Format defined, not implemented
- **TODO**: Implement status list credential issuance and checking

#### 10.5.3 Collection Resolution
- **Status**: Specified in whitepaper, not implemented in SDK
- **TODO**: Implement heritage and curated collection resolution

#### 10.5.4 Advanced BBS+ Cryptosuite
- **Status**: Partial implementation, not integrated
- **TODO**: Complete BBS+ selective disclosure support

---

## 11. Open Questions

### 11.1 Technical Questions

#### 11.1.1 DID Resolution Caching
**Question**: What is the optimal TTL for cached DID resolution results?

**Considerations**:
- Bitcoin confirmations take ~10 minutes
- Did:webvh can update frequently
- Did:peer is static

**Proposed**:
- did:peer: indefinite (static)
- did:webvh: 5 minutes
- did:btco: 1 hour after 6 confirmations

#### 11.1.2 Fee Estimation Strategy
**Question**: How to handle Bitcoin fee volatility?

**Considerations**:
- Fees can spike 10x during high demand
- Underpaying causes stuck transactions
- Overpaying wastes user funds

**Proposed**:
- Use multiple fee oracle sources
- Allow user override with warnings
- Implement RBF (Replace-By-Fee) for stuck transactions

#### 11.1.3 Inscription Size Limits
**Question**: What is the practical maximum inscription size?

**Considerations**:
- Bitcoin block size limit: 4MB
- Typical limit: ~400KB per inscription
- Larger inscriptions = higher fees

**Proposed**:
- Document 400KB soft limit
- Support chunking for larger assets
- Use off-chain storage with hash anchoring

### 11.2 Design Questions

#### 11.2.1 DID Binding Strategy
**Question**: Should assets maintain all DID identifiers as they migrate?

**Current**: Stored in `asset.bindings` object

**Alternatives**:
1. Single canonical DID (latest layer)
2. All DIDs with primary/secondary designation
3. DID resolution chain (each layer references previous)

**Recommendation**: Current approach with `alsoKnownAs` in DID Documents

#### 11.2.2 Credential Accumulation
**Question**: Should all credentials be kept or pruned?

**Current**: All credentials accumulated in array

**Considerations**:
- Provenance requires full history
- Large credential sets may impact performance
- Some credentials may expire

**Recommendation**: Keep all, add pagination API in future

#### 11.2.3 Resource Storage Strategy
**Question**: Should resources be immutable or updatable at each layer?

**Current**: Resources get URLs added but hashes preserved

**Considerations**:
- Immutability aids verification
- Updates may be necessary for corrections
- Version history useful for provenance

**Recommendation**: Resources immutable within layer; new version = new resource

### 11.3 Specification Ambiguities

#### 11.3.1 Deactivation Format
**Whitepaper (v0.1.0)**: Inscription content "🔥" indicates deactivation

**Whitepaper (v0.2.0)**: Metadata `"deactivated": true` indicates deactivation

**Current Implementation**: Checks for 🔥 in content (legacy support)

**Resolution Needed**: Support both formats for backward compatibility

#### 11.3.2 Resource Identifier Format
**Whitepaper**: Some ambiguity between indexed (`/0`) and full inscription ID (`/{hex}i{num}`)

**Current Implementation**: Supports both formats

**Clarification**: Both are valid; indexed is preferred for brevity

#### 11.3.3 Identity vs Content References
**Whitepaper**: 
- Issuer uses non-indexed form: `did:btco:123`
- Subject may use indexed form: `did:btco:123/0`
- Verification method uses indexed form: `did:btco:123/0#key-1`

**Rationale**: 
- Identity (issuer/subject) stable across inscriptions
- Content (specific artwork) tied to inscription
- Keys must reference exact inscription

**Recommendation**: Document this distinction clearly in developer guide

### 11.4 Future Enhancements

#### 11.4.1 Multi-Signature Support
**Question**: Should the SDK support multi-sig DID control?

**Use Case**: DAOs, joint ownership

**Complexity**: Requires threshold signatures or coordination

**Priority**: Medium

#### 11.4.2 Zero-Knowledge Proofs
**Question**: Should selective disclosure be a core feature?

**Current**: BBS+ partially implemented

**Use Case**: Privacy-preserving credentials

**Priority**: Low (niche use case)

#### 11.4.3 Cross-Chain Support
**Question**: Should other blockchains be supported?

**Candidates**: Ethereum, Polygon, Solana

**Complexity**: Each chain has different inscription mechanisms

**Priority**: Low (Bitcoin focus)

#### 11.4.4 Batch Operations
**Question**: Should batch inscription be supported?

**Use Case**: Issuing multiple credentials at once

**Cost Savings**: Significant (shared transaction overhead)

**Priority**: High

---

## Appendix A: Reference Implementations

### A.1 Creating an Asset

```typescript
import { OriginalsSDK } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'testnet',
  defaultKeyType: 'Ed25519',
  enableLogging: true
});

const resources = [{
  id: 'artwork-001',
  type: 'image',
  contentType: 'image/png',
  hash: 'abc123...', // SHA-256 hash
  content: 'base64-encoded-image-data'
}];

const asset = await sdk.lifecycle.createAsset(resources);
console.log('Created:', asset.id); // did:peer:...
```

### A.2 Full Lifecycle

```typescript
// Create in private layer
const asset = await sdk.lifecycle.createAsset(resources);

// Publish for discovery
await sdk.lifecycle.publishToWeb(asset, 'artist-gallery.com');
console.log('Published at:', asset.bindings['did:webvh']);

// Inscribe on Bitcoin
await sdk.lifecycle.inscribeOnBitcoin(asset, 10); // 10 sat/vB
console.log('Inscribed as:', asset.bindings['did:btco']);

// Transfer to buyer
const tx = await sdk.lifecycle.transferOwnership(
  asset,
  'bc1q...' // Bitcoin address
);
console.log('Transferred in tx:', tx.txid);
```

### A.3 Verifying an Asset

```typescript
const isValid = await asset.verify({
  didManager: sdk.did,
  credentialManager: sdk.credentials,
  fetch: global.fetch
});

if (isValid) {
  const provenance = asset.getProvenance();
  console.log('Creator:', provenance.creator);
  console.log('Migrations:', provenance.migrations);
  console.log('Transfers:', provenance.transfers);
}
```

### A.4 Issuing a Credential

```typescript
import { KeyManager } from '@originals/sdk';

const km = new KeyManager();
const keyPair = await km.generateKeyPair('Ed25519');

const unsigned = await sdk.credentials.createResourceCredential(
  'ResourceCreated',
  {
    id: 'did:btco:123456/0',
    resourceType: 'artwork',
    createdAt: new Date().toISOString()
  },
  'did:btco:123456'
);

const signed = await sdk.credentials.signCredential(
  unsigned,
  keyPair.privateKey,
  'did:btco:123456#key-1'
);

const verified = await sdk.credentials.verifyCredential(signed);
```

---

## Appendix B: Error Code Reference

| Code | Description | Resolution |
|------|-------------|------------|
| `INVALID_DID_FORMAT` | DID string doesn't match expected format | Check DID syntax |
| `INVALID_TRANSITION` | Attempted migration not allowed | Verify current layer and target |
| `INVALID_DOMAIN` | Domain doesn't meet RFC requirements | Use valid domain |
| `SATOSHI_REQUIRED` | Satoshi number not provided | Provide valid satoshi |
| `ORD_PROVIDER_UNSUPPORTED` | Provider doesn't support operation | Configure compatible provider |
| `ORD_PROVIDER_INVALID_RESPONSE` | Provider returned malformed data | Check provider health |
| `MISSING_PROVIDER` | No provider configured | Set ordinalsProvider in config |
| `VERIFICATION_FAILED` | Cryptographic verification failed | Check signature and keys |
| `NOT_FOUND` | Resource not found | Verify identifier |
| `EXPIRED_CREDENTIAL` | Credential past expiration date | Issue new credential |
| `REVOKED_CREDENTIAL` | Credential has been revoked | Check status list |

---

## Appendix C: Glossary

**Asset**: A digital object with verifiable provenance tracked through the Originals Protocol

**DID**: Decentralized Identifier - W3C standard for decentralized identity

**Inscription**: Arbitrary data embedded in Bitcoin transactions via ordinals protocol

**Multikey**: Verification method type supporting multiple cryptographic key formats

**Ordinal**: Unique serial number assigned to each satoshi based on mining order

**Provenance**: Complete history of an asset's creation, migrations, and transfers

**Satoshi**: Smallest unit of Bitcoin (1 BTC = 100,000,000 satoshis)

**Verifiable Credential**: W3C standard for tamper-evident credentials

**WebVH**: Web Verifiable History - DID method using HTTPS with version control

---

## Document Control

**Change Log**:

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-09-30 | Originals Team | Initial specification |

**Review Status**: Draft for Implementation

**Approvals**: Pending

**Next Review**: After initial implementation phase

---

**END OF SPECIFICATION**
