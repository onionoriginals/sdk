# Originals Protocol Specification v1.0

**Status**: First Release Foundation
**Based on**: Originals Whitepaper v1.1 (August 2025)
**Implementation**: TypeScript SDK (packages/sdk/)
**Last Updated**: November 2025

---

## Table of Contents

1. [Abstract](#abstract)
2. [Introduction](#introduction)
3. [System Architecture](#system-architecture)
4. [Data Model](#data-model)
5. [Protocol Layers](#protocol-layers)
6. [Credential Types](#credential-types)
7. [Cryptography](#cryptography)
8. [Bitcoin Integration](#bitcoin-integration)
9. [Migration Rules](#migration-rules)
10. [Security Considerations](#security-considerations)
11. [Implementation Guidelines](#implementation-guidelines)
12. [Use Cases](#use-cases)
13. [Conformance](#conformance)

---

## 1. Abstract

Originals is a minimal protocol for creating, discovering, and transferring digital assets with cryptographically verifiable provenance. Assets are represented by Decentralized Identifiers (DIDs) and Verifiable Credentials (VCs) that migrate unidirectionally through three infrastructure-native layers:

- **Layer 1 (Private)**: `did:peer` — Self-contained identifiers for offline creation
- **Layer 2 (Public)**: `did:webvh` — Web-hosted identifiers for discovery
- **Layer 3 (Transferable)**: `did:btco` — Bitcoin-inscribed identifiers for permanent ownership

The protocol requires no smart contracts, trusted third parties, or bespoke blockchains. Ownership is secured by Bitcoin's consensus, while creation and discovery remain free and open.

---

## 2. Introduction

### 2.1 Problem Statement

Existing digital asset systems fail to provide simultaneous:
- **Authentic provenance** - Proof of creation and ownership chain
- **Economic alignment** - Security proportional to asset value
- **Low barrier to entry** - Free experimentation before commitment
- **Censorship resistance** - Permanent ownership without intermediaries

NFT systems pin content hashes but link to mutable URLs. Traditional digital media offers discovery without cryptographic guarantees. This creates a false choice between usability and security.

### 2.2 Protocol Goals

1. **Minimal Design**: Use existing standards (DIDs, VCs, Bitcoin Ordinals) without bespoke infrastructure
2. **Economic Layering**: Align security cost with asset value through voluntary migration
3. **Unidirectional Progression**: Prevent downgrade attacks via one-way layer transitions
4. **Cryptographic Auditability**: Full provenance chain verifiable by any client
5. **Infrastructure Native**: Leverage HTTPS for web discovery and Bitcoin for final settlement

### 2.3 Design Principles

- **Self-sovereignty**: Assets owned and controlled by creators, not platforms
- **Open standards**: Uses W3C DIDs, VCs, Multikey encoding
- **No intermediaries**: Verification possible without third-party services
- **Cost proportionality**: Fees scale with security requirements, not usage
- **Irreversible decisions**: Layer transitions create immutable records

---

## 3. System Architecture

### 3.1 Core Components

```
┌─────────────────────────────────────────────┐
│           Originals SDK                      │
├─────────────────────────────────────────────┤
│                                               │
│  ┌──────────────┐  ┌──────────────┐         │
│  │  DID Manager │  │Lifecycle Mgr │         │
│  │  (all layers)│  │  (migration) │         │
│  └──────────────┘  └──────────────┘         │
│         ↓                   ↓                 │
│  ┌──────────────┐  ┌──────────────┐         │
│  │  Credential  │  │  Bitcoin Mgr │         │
│  │   Manager    │  │ (ordinals)   │         │
│  └──────────────┘  └──────────────┘         │
│                                               │
└─────────────────────────────────────────────┘
         ↓              ↓              ↓
    ┌─────────┐  ┌─────────┐  ┌──────────┐
    │did:peer │  │did:webvh│  │did:btco  │
    │(offline)│  │ (HTTPS) │  │(Bitcoin) │
    └─────────┘  └─────────┘  └──────────┘
```

### 3.2 Manager Responsibilities

| Manager | Responsibility | Supported Layers |
|---------|-----------------|------------------|
| **DIDManager** | Create, migrate, resolve DIDs | All three |
| **CredentialManager** | Issue, sign, verify credentials | All three |
| **LifecycleManager** | Orchestrate asset operations | All three |
| **BitcoinManager** | Inscribe, transfer, track | did:btco |

---

## 4. Data Model

### 4.1 Core Objects

#### 4.1.1 OriginalsAsset

Represents a digital asset and its state across layers:

```typescript
interface OriginalsAsset {
  // Identification
  id: string;                    // Asset UUID
  createdAt: Date;               // Creation timestamp
  creator: string;               // Creator DID

  // Layer-specific DIDs
  layers: {
    peer?: string;               // did:peer (if created)
    webvh?: string;              // did:webvh (if published)
    btco?: string;               // did:btco (if inscribed)
  };

  // Content
  resources: Resource[];         // Digital content
  credentials: Credential[];     // Verifiable credentials

  // Provenance
  provenance: {
    creationTimestamp: number;
    migrations: Migration[];      // Layer transitions
    transfers: Transfer[];        // Ownership changes
  };

  // Version
  version: string;               // Current version
  previousVersions?: string[];   // Historical versions
}
```

#### 4.1.2 Resource

Represents digital content (images, text, code, data, etc.):

```typescript
interface Resource {
  id: string;                    // Resource identifier
  type: string;                  // Media type (image, text, code, data)
  contentType: string;           // MIME type (image/png, text/plain, etc.)
  hash: string;                  // Content hash (SHA-256)
  size: number;                  // Bytes
  url?: string;                  // Content location (populated at Layer 2+)
  metadata?: Record<string, unknown>;  // Additional properties
}
```

#### 4.1.3 Migration

Records a layer transition:

```typescript
interface Migration {
  from: DIDidLayer;              // Source layer
  to: DIDidLayer;                // Target layer
  timestamp: number;             // Timestamp
  transactionId?: string;        // Bitcoin txid (if Layer 3)
  cost?: number;                 // Satoshis or dollars
  proof: Credential;             // ResourceMigrated credential
}
```

---

## 5. Protocol Layers

### 5.1 Layer 1: did:peer (Private Creation)

**Purpose**: Private creation and experimentation, offline verification

**Format**: W3C DID Core compliant, variant 4 long-form

**Example**:
```
did:peer:4z...very-long-base58-encoded-string
```

**Structure**:
```typescript
interface DIDPeerDocument {
  "@context": string[];
  "id": string;                          // did:peer identifier
  "verificationMethod": VerificationMethod[];
  "authentication": string[];
  "assertion": string[];
  "resources": Resource[];
  "credentials": Credential[];
}
```

**Constraints**:
- ✅ Self-contained (no external resolution required)
- ✅ Offline verifiable
- ✅ No network requirements
- ✅ Can be transmitted via any medium
- ⛔ Not discoverable on public web

**Cost**: $0 (free)

**Operations**:
- `create()` - Generate new did:peer document
- `verify()` - Offline verification (no network needed)
- `publish()` - Publish to Layer 2 or Layer 3

**Key Types**: ES256K (secp256k1), Ed25519, ES256 (secp256r1)

**Encoding**: Multibase (base58btc) + Multicodec

**Example Implementation** (TypeScript):
```typescript
const asset = await sdk.did.createDIDPeer({
  keyType: 'Ed25519',
  resources: [{
    id: 'artwork-1',
    type: 'image',
    contentType: 'image/png',
    hash: 'sha256-...'
  }]
});

// Returns: did:peer:4z...
```

---

### 5.2 Layer 2: did:webvh (Public Discovery)

**Purpose**: Public asset discoverability via HTTPS hosting

**Format**: W3C DID Core + didwebvh-ts specification

**Example**:
```
did:webvh:example.com:alice
```

**Structure**:
```typescript
interface DIDWebVHDocument {
  "@context": string[];
  "id": string;                          // did:webvh identifier
  "created": string;                     // ISO timestamp
  "updated": string;                     // ISO timestamp
  "method": "did:webvh";
  "domain": string;                      // example.com
  "path": string;                        // alice
  "verificationMethod": VerificationMethod[];
  "authentication": string[];
  "assertion": string[];
  "service": ServiceEndpoint[];
  "resources": Resource[];
  "credentials": Credential[];
}
```

**Hosting Requirements**:
- ✅ Must be served from HTTPS-protected endpoint
- ✅ Stored at: `/.well-known/did.jsonl`
- ✅ Each DID version appended as JSONL line
- ✅ Must be world-readable

**Resolution**:
```
HTTPS GET https://example.com/.well-known/did.jsonl

Returns: One JSON object per line (JSONL format)
```

**Constraints**:
- ✅ Public discovery via web crawlers
- ✅ HTTPS-only (no plain HTTP)
- ✅ Verifiable via domain control
- ✅ Version history preserved
- ⛔ Depends on web hosting availability

**Cost**: ~$25/year (typical HTTPS hosting)

**Operations**:
- `create()` - Generate new did:webvh document
- `update()` - Add new version to JSONL log
- `resolve()` - Retrieve latest version from HTTPS endpoint
- `getHistory()` - Retrieve all versions from JSONL

**Publishing Pattern**:
```
1. Create DID document at Layer 1 (did:peer)
2. Migrate to Layer 2:
   a. Domain verification (CNAME or file-based)
   b. Save DID log to /.well-known/did.jsonl
   c. Create ResourceMigrated credential
   d. Emit asset:migrated event
3. Asset now discoverable via domain
```

**Example Implementation**:
```typescript
const asset = await sdk.did.createDIDWebVH({
  domain: 'artist.com',
  path: 'paintings/mona-lisa',
  outputDir: './public/.well-known'
});

// Uploads DID document to artist.com/.well-known/did.jsonl
// Returns: did:webvh:artist.com:paintings%2Fmona-lisa
```

**External Signer Integration**:
```typescript
const signer = createTurnkeySigner(...);  // Turnkey, AWS KMS, HSM, etc.

const asset = await sdk.did.createDIDWebVH({
  domain: 'artist.com',
  externalSigner: signer,  // Hardware wallet or cloud HSM
  verificationMethods: [...]
});
```

---

### 5.3 Layer 3: did:btco (Permanent Ownership)

**Purpose**: Bitcoin-anchored permanent ownership with censorship resistance

**Format**: W3C DID Core + Bitcoin Ordinals extension

**Example**:
```
did:btco:mainnet:6a8c92b1...
```

**Structure**:
```typescript
interface DIDbtcoDocument {
  "@context": string[];
  "id": string;                          // did:btco identifier (immutable)
  "method": "did:btco";
  "network": "mainnet" | "testnet" | "signet" | "regtest";
  "inscriptionId": string;               // Bitcoin Ordinals ID (immutable)
  "satoshi": number;                     // Satoshi number (immutable - DID identifier)
  "transactionId": string;               // Inscription reveal TXID (immutable)
  "vout": number;                        // Output index (immutable)
  "blockHeight": number;                 // Confirmation block (immutable)
  "created": string;                     // ISO timestamp (immutable)
  "modified": string;                    // Last update timestamp of current owner
  "verificationMethod": VerificationMethod[];
  "authentication": string[];
  "assertion": string[];
  "proof": Proof;                        // Bitcoin proof (immutable)
  "status": "active" | "deactivated";
  "resources": Resource[];
  "credentials": Credential[];
}
```

**Note on Immutability**: All fields except `modified` are immutable once inscribed. The satoshi number is the permanent identifier that never changes, even during ownership transfers.

**Inscription Format**:

DID document inscribed as CBOR-encoded data:
```
Content-Type: application/cbor
Body: CBOR(DIDbtcoDocument)
```

**Bitcoin Inscription Process**:

1. **Commit Phase** (Front-running prevention):
   - Create commit transaction with unique satoshi assignment
   - Locks satoshi on-chain
   - Prevents preimage attacks

2. **Reveal Phase** (Inscription):
   - Create reveal transaction
   - Inscribe DID document on locked satoshi
   - Returns inscription ID and transaction hash

**Constraints**:
- ✅ **Immutable once inscribed** - The DID identifier, satoshi number, and inscription cannot be changed
- ✅ **Ownership transferable** - The UTXO can be moved to a new owner's address, but the DID and its history remain unchanged
- ✅ Censorship resistant (Bitcoin finality)
- ✅ Publicly verifiable
- ✅ Front-running protected via satoshi uniqueness
- ✅ Cross-chain verifiable
- ⛔ Requires Bitcoin transaction fees

**Cost**: $75–200 (varies by network congestion)

**Networks Supported**:
- `mainnet` - Production Bitcoin
- `testnet` - Bitcoin testnet (free satoshis)
- `signet` - Coordinated testnet for testing
- `regtest` - Local regression testing

**Operations**:
- `inscribe()` - Create did:btco from did:peer or did:webvh (creates new inscription on new satoshi)
- `transfer()` - Transfer ownership to new Bitcoin address (moves UTXO, no new inscription)
- `resolve()` - Query Bitcoin to retrieve DID document (reads from immutable satoshi)
- `deactivate()` - Mark as no longer active (appends deactivation marker, does not modify original inscription)

**Ownership Transfer**:

Ownership transfer moves the UTXO containing the inscribed satoshi to a new Bitcoin address. The DID remains bound to the same satoshi and inscription ID.

```typescript
// Transfer did:btco to new Bitcoin address
const transfer = await sdk.bitcoin.transferInscription({
  inscriptionId: '...',                    // Identifies satoshi
  recipientAddress: 'bc1...',              // New owner's address
  feeRate: 15                              // satoshis per byte
});

// Results in:
// 1. UTXO moved to recipientAddress (ownership transferred)
// 2. did:btco identifier remains unchanged (same satoshi)
// 3. New owner controls the inscribed satoshi
// 4. DID document is NOT rewritten (immutability preserved)
// 5. Transfer recorded in ownership/transfer credentials
```

**Critical Constraint**: The DID identifier (did:btco:mainnet:6a8c92b1...) is permanently tied to its satoshi number. Transferring ownership changes who controls the satoshi via Bitcoin UTXO ownership, but does NOT change the DID identifier or create a new inscription.

**Resolution Example**:
```typescript
const did = 'did:btco:mainnet:6a8c92b1...';
const document = await sdk.did.resolveDID(did);

// Returns full DID document with current state
// Verified against Bitcoin blockchain
```

---

## 6. Credential Types

### 6.1 ResourceCreated

Issued when an asset is created at Layer 1 (did:peer):

```typescript
interface ResourceCreated extends VerifiableCredential {
  "@context": string[];
  "type": ["VerifiableCredential", "ResourceCreated"];
  "issuer": string;                      // Creator DID
  "credentialSubject": {
    id: string;                          // Asset ID
    resourceId: string;                  // Resource ID
    resourceHash: string;                // SHA-256 hash
    contentType: string;                 // MIME type
    created: string;                     // ISO timestamp
    creator: string;                     // Creator DID
  };
  "proof": Proof;                        // EdDSA or BBS+ proof
}
```

**Issued by**: Creator
**Signed with**: Creator's did:peer verification key
**Use**: Establish asset creation and creator identity

---

### 6.2 ResourceUpdated

Issued when a resource is updated (new version):

```typescript
interface ResourceUpdated extends VerifiableCredential {
  "@context": string[];
  "type": ["VerifiableCredential", "ResourceUpdated"];
  "issuer": string;                      // Resource author
  "credentialSubject": {
    id: string;                          // Asset ID
    resourceId: string;                  // Resource ID
    previousHash: string;                // Old SHA-256
    newHash: string;                     // New SHA-256
    newContentType: string;              // Updated MIME type
    updated: string;                     // ISO timestamp
    reason?: string;                     // Update reason
  };
  "proof": Proof;                        // Data Integrity proof
}
```

**Issued by**: Resource author
**Signed with**: Current layer's verification key
**Use**: Record resource modifications and version history

---

### 6.3 ResourceMigrated

Issued when an asset moves to a new layer:

```typescript
interface ResourceMigrated extends VerifiableCredential {
  "@context": string[];
  "type": ["VerifiableCredential", "ResourceMigrated"];
  "issuer": string;                      // Current layer issuer
  "credentialSubject": {
    id: string;                          // Asset ID
    fromDID: string;                     // Source DID
    toDID: string;                       // Target DID
    fromLayer: "peer" | "webvh" | "btco";
    toLayer: "peer" | "webvh" | "btco";
    migratedAt: string;                  // ISO timestamp
    transactionId?: string;              // Bitcoin TXID (if Layer 3)
    cost?: number;                       // Cost in satoshis or USD
  };
  "proof": Proof;                        // Data Integrity proof
}
```

**Issued by**: Migration orchestrator
**Signed with**: Corresponding layer's verification key
**Use**: Document layer transitions and create auditable provenance chain

---

## 7. Cryptography

### 7.1 Supported Key Types

| Type | Algorithm | Curve | Use Case | Multicodec |
|------|-----------|-------|----------|-----------|
| **ES256K** | ECDSA | secp256k1 | Bitcoin operations | 0xE7 |
| **Ed25519** | EdDSA | Ed25519 | Credential signing | 0xED |
| **ES256** | ECDSA | secp256r1 | FIPS compliance | 0x1200 |

### 7.2 Key Encoding

All keys use **Multibase + Multicodec** encoding (not JWK):

```
Format: z<base58btc-encoded-key>

Example:
z6MkhaXgBZDvotfJOH9F9g-nqT2x5n8MQhWfAZUSDJZZ99

Components:
- z = multibase indicator (base58btc)
- 6M = multicodec (Ed25519 public key)
- ... = encoded key material
```

**Verification Method**:
```typescript
interface VerificationMethod {
  "id": string;                          // DID URL
  "type": "Multikey";
  "controller": string;                  // DID
  "publicKeyMultibase": string;          // z-encoded key
}
```

### 7.3 Signature Schemes

#### 7.3.1 EdDSA (Primary)

**Cryptosuite**: `eddsa-2022`

**Algorithm**:
1. Canonicalize credential to JSON-LD in canonical form
2. Hash with SHA-256
3. Sign with Ed25519 private key
4. Encode signature as multibase

**Proof Structure**:
```typescript
interface Proof {
  "type": "DataIntegrityProof";
  "cryptosuite": "eddsa-2022";
  "created": string;                     // ISO timestamp
  "verificationMethod": string;          // DID URL
  "proofPurpose": "assertionMethod" | "authentication";
  "proofValue": string;                  // z-encoded signature
}
```

#### 7.3.2 BBS+ (Selective Disclosure)

**Cryptosuite**: `bbs-2023`

**Use Case**: Reveal selective fields in credentials without exposing entire document

**Proof Structure**:
```typescript
interface BBSProof {
  "type": "DataIntegrityProof";
  "cryptosuite": "bbs-2023";
  "created": string;
  "verificationMethod": string;
  "proofPurpose": "assertionMethod";
  "proofValue": string;                  // BBS+ derived proof
  "requiredCanonicalForm": boolean;      // true
}
```

### 7.4 Verification Process

**Credential Verification**:
1. Resolve issuer DID to get verification method
2. Extract public key from verification method
3. Retrieve proof from credential
4. Recreate canonical JSON-LD form
5. Hash with same algorithm
6. Verify signature matches proof value
7. Check proof timestamp within acceptable bounds
8. Verify cryptosuite is supported

**DID Document Verification**:
1. Resolve DID (layer-dependent)
2. Verify all credentials in document
3. Check verification method signatures
4. For did:btco: verify Bitcoin inscription exists

---

## 8. Bitcoin Integration

### 8.1 Inscription Format

**Content Type**: `application/cbor`

**Payload**: CBOR-encoded DID document

**Maximum Size**: ~4 MB (Bitcoin blockchain standard)

**Encoding**:
```
Inscription = {
  content-type: "application/cbor",
  body: CBOR(DIDbtcoDocument)
}
```

### 8.2 Commit-Reveal Pattern

**Purpose**: Prevent front-running attacks

**Phase 1: Commit**
```
Commit TX:
├─ Input: Funding UTXO (user's satoshis)
├─ Output 0: Unique satoshi assignment
│  └─ Value: 546 satoshis (dust limit)
│  └─ Script: OP_RETURN (marks satoshi)
└─ Fees: ~50-100 satoshis

Result: Satoshi locked on-chain, prevents duplicate inscription
```

**Phase 2: Reveal**
```
Reveal TX:
├─ Input 0: Commit TX output (locked satoshi)
├─ Output 0: Inscribed satoshi with DID data
│  ├─ OP_PUSH_1 (0x51)
│  ├─ OP_PUSH_33 (0x21) + signature
│  ├─ OP_PUSH_33 (0x21) + pubkey
│  ├─ OP_CHECKDATASIG OP_NOP
│  ├─ OP_FALSE OP_IF
│  │  ├─ OP_PUSH "ord"
│  │  ├─ OP_PUSH 1
│  │  ├─ OP_PUSH "application/cbor"
│  │  ├─ OP_PUSH 0
│  │  └─ OP_PUSH <CBOR-encoded-DID>
│  └─ OP_ENDIF
└─ Fees: ~150-300 satoshis (depends on inscription size)
```

**Security Properties**:
- ✅ Satoshi uniqueness prevents duplicate inscriptions
- ✅ Two-phase structure prevents preimage attacks
- ✅ Commit is immutable once broadcast
- ✅ Only reveal phase can be cancelled

### 8.3 UTXO Selection

**Strategy**: Ordinal-aware UTXO selection

1. Fetch UTXOs from wallet address
2. Assign ordinal ranges to each UTXO
3. Select UTXOs that don't conflict with existing inscriptions
4. Verify satoshi uniqueness in selected UTXO
5. Lock selected satoshi for inscription

### 8.4 Fee Structure

**Dynamic Fees**:
- Recommended: Use FeeOracleAdapter to fetch mempool rates
- Source: Mempool.space, Blockchair, or custom oracle
- Updated every 10 minutes

**Manual Override**:
- Range: 1-10,000 satoshis per byte
- Typical: 5-50 sat/vB depending on urgency

**Cost Estimation**:
```
Total Cost = (Commit Size + Reveal Size) × Fee Rate

Typical:
- Small DID: $50-100
- Medium DID: $100-200
- Large DID: $200-500
```

### 8.5 Network Support

| Network | Use Case | Satoshi Type | Cost |
|---------|----------|--------------|------|
| **mainnet** | Production | Real BTC | Varies ($75-200) |
| **testnet** | Testing | Free testnet BTC | Free |
| **signet** | Coordinated testing | Coordinated satoshis | Free |
| **regtest** | Local development | Local mock satoshis | Free |

---

## 9. Migration Rules

### 9.1 Layer Transitions

**Allowed Transitions**:
- ✅ `did:peer` → `did:webvh` (publish to web)
- ✅ `did:webvh` → `did:btco` (inscribe on Bitcoin)
- ✅ `did:peer` → `did:btco` (direct to Bitcoin)

**Forbidden Transitions**:
- ❌ `did:webvh` → `did:peer` (no downgrade)
- ❌ `did:btco` → `did:webvh` (no downgrade)
- ❌ `did:btco` → `did:peer` (no downgrade)

**Rationale**: Prevents downgrade attacks that could invalidate previous claims.

### 9.2 Migration Validation

**Pre-Migration Checks**:

1. **DID Compatibility**:
   - Source DID exists and is valid
   - Target layer supports source content
   - No circular references

2. **Credential Integrity**:
   - All credentials in asset are valid
   - Issuer keys are accessible
   - Proofs are verifiable

3. **Storage Readiness** (for did:webvh):
   - HTTPS hosting available
   - Directory writable
   - Domain ownership verified

4. **Bitcoin Readiness** (for did:btco):
   - OrdinalsProvider configured
   - Sufficient satoshis in wallet
   - Network accessible

5. **Lifecycle Compliance**:
   - No pending migrations
   - Asset state consistent
   - No conflicts with existing resources

### 9.3 Migration Process

**State Machine**:
```
VALIDATING
    ↓ (validation passes)
CHECKPOINTED (snapshot created)
    ↓
IN_PROGRESS (migration executing)
    ↓ (success)
COMPLETED
    ↓
(or FAILED → QUARANTINE if unrecoverable)
```

**Checkpointing**:
1. Create snapshot of asset state
2. Store in temporary checkpoint storage
3. Store for 24 hours for recovery
4. Auto-delete after expiration

**Rollback**:
1. If migration fails at any stage
2. Restore from checkpoint
3. Mark as FAILED
4. If rollback itself fails, move to QUARANTINE
5. User must manually investigate

### 9.4 Batch Migration Optimization

**Important Distinction: Layer Migration vs. Ownership Transfer**

- **Layer Migration** (did:peer → did:webvh or did:webvh → did:btco): Creates a NEW DID document in the target layer
  - Layer 1→2: New did:webvh document created
  - Layer 2→3: New did:btco inscription on NEW satoshi
  - Results in multiple DIDs pointing to same asset (different satoshis)

- **Ownership Transfer** (within did:btco): Transfers control of EXISTING inscription
  - UTXO moves to new owner's address
  - Satoshi number remains unchanged
  - DID identifier remains unchanged
  - No new inscription created
  - Original inscription and history preserved forever

**Single-Transaction Inscription**:

When inscribing multiple assets via Layer 2→3 migration:
1. Combine multiple DID documents into batch metadata
2. Inscribe batch in single Bitcoin transaction
3. Reference batch in each asset's migration credential
4. Calculate cost savings dynamically (typically 30%+ reduction)
5. Distribute fees proportionally among assets

**Example**:
```
Normal (3 separate inscriptions):
- TX 1: Asset A (200 bytes) → ~$150
- TX 2: Asset B (200 bytes) → ~$150
- TX 3: Asset C (200 bytes) → ~$150
- Total: ~$450

Batch (single transaction):
- TX 1: Batch(A+B+C) (600 bytes) → ~$350
- Savings: $100 (22% reduction)

Per-asset cost:
- Asset A: $117 (33% of batch fee)
- Asset B: $117 (33% of batch fee)
- Asset C: $116 (33% of batch fee)
```

---

## 10. Security Considerations

### 10.1 Data Integrity

**Guarantee**: All credentials include W3C Data Integrity proofs

**Verification**: Any party can verify:
- Credential authenticity (signed by issuer)
- Content integrity (proof matches current state)
- Timestamp validity (issue time is reasonable)
- Issuer legitimacy (DID resolves to valid issuer)

**Tamper Detection**: Modified credentials fail verification

### 10.2 Key Compromise & Recovery

**Key Rotation**:
- Generate new keypair
- Create rotation credential signed by old key
- Update DID document with new verification method
- Mark old key as revoked
- Previous signatures remain valid

**Recovery from Compromise**:
- Revoke compromised key
- Rotate to new key
- Continue asset operations with new key
- Historical provenance remains intact

### 10.3 Front-Running Prevention

**Attack**: Attacker observes pending inscription and inscribes first with their DID

**Defense**: Commit-Reveal Pattern
- Satoshi assignment is unique (assigned in commit phase)
- Reveal phase cannot inscribe different data on same satoshi
- Preimage attacks impossible (satoshi locked before reveal)

### 10.4 Censorship Resistance

**did:peer**: Cannot be censored (offline)
**did:webvh**: Can be censored by domain owner, but alternative domains possible
**did:btco**: Cannot be censored (Bitcoin consensus makes reversal prohibitively expensive)

**Mitigation**: Important assets should migrate to Layer 3 for permanent record

### 10.5 Input Validation

All operations validate:
- Bitcoin addresses (checksum + network validation)
- Satoshi numbers (range 0-20,999,999.99 BTC)
- MIME types (RFC 2045 compliance)
- DID format (method-specific rules)
- Fee rates (1-10,000 sat/vB bounds)
- Resource sizes (< 4 MB)
- Path traversal attempts (on did:webvh storage)

### 10.6 Storage Security

**did:webvh Storage**:
- ✅ Path traversal protection (no `..` in paths)
- ✅ Domain sanitization (prevent subdomain injection)
- ✅ File permissions (world-readable for discovery)
- ✅ HTTPS-only (no plain HTTP)

**Key Storage**:
- ✅ Private keys never logged
- ✅ Multibase encoding (no JWK format)
- ✅ External signer support for HSM/cloud custody
- ✅ Configurable sensitive data sanitization

---

## 11. Implementation Guidelines

### 11.1 SDK Configuration

**Minimal Configuration**:
```typescript
const sdk = OriginalsSDK.create({
  network: 'testnet',
  ordinalsProvider: new OrdMockProvider()
});
```

**Production Configuration**:
```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: 'https://ord-api.production.com',
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY
  }),
  feeOracle: {
    estimateFeeRate: async (targetBlocks) => {
      const fees = await fetch('/api/fees').then(r => r.json());
      return targetBlocks <= 1 ? fees.fast : fees.normal;
    }
  },
  enableLogging: true,
  logging: {
    level: 'info',
    sanitizeLogs: true,
    outputs: ['console', 'file:logs/originals.log']
  }
});
```

### 11.2 Workflow: Create → Publish → Inscribe

```typescript
// Step 1: Create asset (Layer 1 - did:peer)
const asset = await sdk.lifecycle.createAsset([
  {
    id: 'artwork-001',
    type: 'image',
    contentType: 'image/png',
    hash: 'sha256-...'
  }
]);

// asset.layers.peer === 'did:peer:4z...'

// Step 2: Publish to web (Layer 2 - did:webvh)
await sdk.lifecycle.publishToWeb(asset, 'example.com');

// asset.layers.webvh === 'did:webvh:example.com:artwork%2F001'

// Step 3: Inscribe on Bitcoin (Layer 3 - did:btco)
const inscribed = await sdk.lifecycle.inscribeOnBitcoin(asset);

// asset.layers.btco === 'did:btco:mainnet:6a8c92b1...'
```

### 11.3 Batch Operations

```typescript
// Create 100 assets and inscribe in single transaction
const assets = await sdk.lifecycle.batchCreateAssets(resources, {
  concurrency: 10
});

await sdk.lifecycle.batchPublishToWeb(assets, 'example.com', {
  concurrency: 5,
  retryCount: 3,
  timeout: 30000
});

const inscribed = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
  mode: 'single-transaction',  // 30%+ cost savings
  feeRate: 15
});

// All assets inscribed in single Bitcoin transaction
// Proportional fees distributed
// Total cost: ~33% less than 100 individual inscriptions
```

### 11.4 Verification

```typescript
// Verify asset at any layer
const asset = await sdk.lifecycle.getAsset(assetId);

// Verify all credentials
const valid = await Promise.all(
  asset.credentials.map(cred =>
    sdk.vc.verifyCredential(cred)
  )
);

// For did:btco, verify Bitcoin inscription
if (asset.layers.btco) {
  const onChain = await sdk.bitcoin.validateBtcoDID(asset.layers.btco);
  console.log('Inscribed on Bitcoin:', onChain);
}
```

---

## 12. Use Cases

### 12.1 Digital Art

**Scenario**: Artist creates digital artwork, shares for feedback, sells with provenance

**Workflow**:
1. Create artwork as did:peer (offline, free experimentation)
2. Share with community for feedback
3. Migrate to did:webvh on artist's website (discoverable)
4. Upon sale, inscribe as did:btco (permanent ownership record)
5. Buyer receives did:btco with full provenance chain

**Economics**:
- Artist's cost: $0 (did:peer) + $25/year (did:webvh) + $150 (did:btco)
- Total: ~$175 one-time

---

### 12.2 Scientific Data

**Scenario**: Researcher documents dataset, publishes for peer review, archives permanently

**Workflow**:
1. Create dataset as did:peer (private lab use)
2. Collaborate with lab members (offline verification)
3. Migrate to did:webvh on institution server (peer review access)
4. After publication, inscribe as did:btco (permanent record)
5. Citations reference immutable Bitcoin-inscribed version

**Economics**:
- Researcher's cost: $0 (did:peer) + $25/year (did:webvh) + $200 (did:btco)
- Total: ~$225 one-time for permanent archive

---

### 12.3 DAO Governance

**Scenario**: DAO issues membership credentials, creates immutable governance record

**Workflow**:
1. Issue member credentials as did:peer (offline, cost-free)
2. Migrate to did:webvh (public member directory)
3. Key governance decisions inscribed as did:btco (immutable record)
4. Future DAOs can verify decisions via Bitcoin

**Economics**:
- Per membership: $0
- Per governance decision: ~$200 (one-time, can batch multiple decisions)

---

### 12.4 Supply Chain Provenance

**Scenario**: Manufacturer tracks product authenticity through supply chain

**Workflow**:
1. Manufacturer creates product credential as did:peer
2. Publishes to did:webvh for public verification (anti-counterfeiting)
3. At final sale, inscribe as did:btco (ownership transfer)
4. Buyer receives verified ownership with full chain of custody

**Economics**:
- Per product: $0 (did:peer) + included in did:webvh + $0.50-2 (did:btco per item in batches)

---

### 12.5 Software Supply Chain

**Scenario**: Open source project proves source integrity and release provenance

**Workflow**:
1. Development builds tracked as did:peer (internal)
2. Minor releases published as did:webvh (discovery)
3. Major releases inscribed as did:btco (governments verify integrity)
4. Enterprises can audit supply chain via Bitcoin

**Economics**:
- Development: Free
- Releases: ~$25-200 depending on frequency

---

### 12.6 Cultural Heritage

**Scenario**: Museums preserve artifacts with immutable provenance records

**Workflow**:
1. Catalog artifacts as did:peer (internal records)
2. Publish to did:webvh (public discovery and research)
3. Permanently inscribe as did:btco (survives institution closure)
4. Future archivists can verify authenticity via Bitcoin

**Economics**:
- Per artifact: $0-250 depending on importance
- Archival value: Immutable records persist centuries

---

## 13. Conformance

### 13.1 Standards Compliance

✅ **W3C DID Core** - All three methods compliant
✅ **W3C Verifiable Credentials** - Data Integrity proofs (not JWT)
✅ **W3C Multibase** - Key encoding (base58btc)
✅ **W3C Multicodec** - Algorithm identification
✅ **Bitcoin Ordinals** - Inscription protocol
✅ **RFC 2045** - MIME type compliance

### 13.2 Interoperability

- ✅ DIDs resolvable by universal DID resolvers
- ✅ Credentials verifiable by any W3C VC library
- ✅ Bitcoin inscriptions readable via ordinals indexers
- ✅ No proprietary formats or protocols

### 13.3 Implementation Requirements

**Mandatory**:
- W3C DID resolution for all three layers
- EdDSA signature generation and verification
- HTTPS enforcement for did:webvh
- Bitcoin transaction validation for did:btco

**Recommended**:
- BBS+ support for selective disclosure
- FeeOracleAdapter for dynamic fee estimation
- ExternalSigner for key management
- Event system for observability

---

## 14. Versioning

**Specification Version**: 1.0
**Release Date**: November 2025
**SDK Implementation**: TypeScript (packages/sdk/)

**Backward Compatibility**:
- Fully backward compatible with Originals Whitepaper v1.1
- Breaking changes will increment major version (e.g., v2.0)

**Upgrades**:
- Additive changes: Minor version bump (e.g., v1.1)
- Non-breaking fixes: Patch version bump (e.g., v1.0.1)

---

## Appendix: Bitcoin Inscription Examples

### Example 1: Simple did:peer Inscription

```json
{
  "id": "did:peer:4z...",
  "verificationMethod": [{
    "id": "#key-1",
    "type": "Multikey",
    "publicKeyMultibase": "z6MkhaXgBZDvotfJOH9F9g-nqT2x5n8MQhWfAZUSDJZZ99"
  }],
  "resources": [{
    "id": "artwork",
    "contentType": "image/png",
    "hash": "sha256-abc123..."
  }]
}
```

### Example 2: Batch Inscription Metadata

```json
{
  "batchId": "batch-2025-11-18-001",
  "assetCount": 50,
  "inscriptions": [
    {
      "assetId": "asset-001",
      "did": "did:btco:mainnet:6a8c92b1...",
      "feePaid": 167  // satoshis
    },
    {
      "assetId": "asset-002",
      "did": "did:btco:mainnet:7b9d93c2...",
      "feePaid": 167
    }
  ],
  "totalFee": 8350,
  "costSavings": 4175,
  "timestamp": "2025-11-18T15:30:00Z"
}
```

---

## References

- [W3C DID Core Specification](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials Data Model](https://www.w3.org/TR/vc-data-model/)
- [Bitcoin Ordinals Protocol](https://docs.ordinals.com/)
- [Multibase Specification](https://github.com/multiformats/multibase)
- [Multicodec Specification](https://github.com/multiformats/multicodec)
- [Originals Whitepaper v1.1](./originals-whitepaper.md)

---

**Document Status**: DRAFT - Ready for Community Review
**Next Steps**: Collect feedback, finalize, publish as RFC

---

*Originals Protocol Specification v1.0*
*Foundation for decentralized, provenance-bearing digital assets*
