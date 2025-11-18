# Originals Protocol Specification v1.0 (DRAFT)

**Status:** DRAFT - Request for Comments
**Version:** 1.0.0-draft.1
**Date:** 2025-11-18
**Authors:** Originals Protocol Working Group

---

## Abstract

The Originals Protocol defines a framework for creating, discovering, and transferring digital assets with cryptographically verifiable provenance using Decentralized Identifiers (DIDs) and Verifiable Credentials (VCs). The protocol organizes digital asset lifecycles into three progressive layers based on economic gravity and security requirements:

1. **did:peer** - Private creation and experimentation (offline, free)
2. **did:webvh** - Public discovery via HTTPS hosting (~$25/year)
3. **did:btco** - Transferable ownership on Bitcoin ($75-200 one-time)

Assets migrate unidirectionally through these layers, with each migration preserving provenance and enabling new capabilities. This specification defines the DID methods, credential schemas, migration rules, and interoperability requirements for protocol-compliant implementations.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Architecture Overview](#3-architecture-overview)
4. [DID Method Specifications](#4-did-method-specifications)
5. [Verifiable Credentials](#5-verifiable-credentials)
6. [Lifecycle & Migration](#6-lifecycle--migration)
7. [Bitcoin Integration](#7-bitcoin-integration)
8. [Cryptographic Requirements](#8-cryptographic-requirements)
9. [Interoperability](#9-interoperability)
10. [Security Considerations](#10-security-considerations)
11. [Privacy Considerations](#11-privacy-considerations)
12. [References](#12-references)

---

## 1. Introduction

### 1.1 Motivation

Digital assets today face challenges in provenance verification, ownership transfer, and cross-platform interoperability. Centralized registries create single points of failure, while fully on-chain solutions impose high costs for all use cases.

The Originals Protocol addresses this through a layered approach:
- **Early-stage assets** remain private and cost-free (did:peer)
- **Published assets** gain web discoverability at low cost (did:webvh)
- **High-value assets** achieve Bitcoin-level immutability when justified (did:btco)

This economic gravity model ensures that infrastructure costs match asset value.

### 1.2 Design Goals

1. **Offline-first**: Assets can be created without network access or fees
2. **Progressive decentralization**: Migrate to stronger guarantees as value increases
3. **Cryptographic provenance**: Every state transition is cryptographically signed
4. **W3C compliance**: Built on DID and VC standards for interoperability
5. **Bitcoin finality**: Ultimate ownership layer leverages Bitcoin's security
6. **Developer-friendly**: Simple APIs for common workflows

### 1.3 Scope

This specification defines:
- Three DID methods (did:peer, did:webvh, did:btco)
- Asset lifecycle state machine
- Verifiable credential schemas for assets and provenance
- Bitcoin inscription format and resolution
- Migration validation rules

This specification does NOT define:
- Application-level asset schemas (left to domain-specific extensions)
- User interface requirements
- Marketplace or transfer protocols beyond DID ownership
- Off-protocol storage solutions (IPFS, Arweave, etc.)

### 1.4 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 2. Terminology

**Asset**: A digital object with cryptographically verifiable provenance, represented by a DID.

**Layer**: One of three DID-based infrastructure levels (peer, webvh, btco).

**Migration**: The unidirectional transition of an asset from one layer to a stronger layer.

**Original**: An asset created within the Originals Protocol with full provenance tracking from creation.

**Resource**: A content-addressed digital file or data object associated with an asset.

**Provenance**: The cryptographic audit trail of an asset's creation, updates, and migrations.

**Inscription**: Data permanently recorded on the Bitcoin blockchain via the Ordinals protocol.

**Satoshi**: The smallest unit of Bitcoin (1 BTC = 100,000,000 satoshis).

**Ordinal**: A unique identification number for each satoshi based on mining order.

**UTXO**: Unspent Transaction Output - Bitcoin's native accounting model.

**Multikey**: W3C multicodec-based key encoding format (replaces JWK in modern DID specs).

**Verification Method**: A cryptographic public key associated with a DID.

---

## 3. Architecture Overview

### 3.1 Three-Layer Model

```
┌─────────────────────────────────────────────────────────────┐
│                        did:btco Layer                       │
│  Bitcoin-inscribed DIDs with immutable ownership            │
│  Cost: $75-200 one-time | Security: Bitcoin consensus       │
└─────────────────────┬───────────────────────────────────────┘
                      ▲ Migration (inscribe)
                      │
┌─────────────────────┴───────────────────────────────────────┐
│                       did:webvh Layer                       │
│  Web-hosted DIDs with version history                       │
│  Cost: ~$25/year | Security: HTTPS + domain control         │
└─────────────────────┬───────────────────────────────────────┘
                      ▲ Migration (publish)
                      │
┌─────────────────────┴───────────────────────────────────────┐
│                       did:peer Layer                        │
│  Offline peer-to-peer DIDs for private creation             │
│  Cost: FREE | Security: Local cryptography only             │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Layer Properties

| Property | did:peer | did:webvh | did:btco |
|----------|----------|-----------|----------|
| **Network Required** | No | Yes (HTTPS) | Yes (Bitcoin) |
| **Resolution** | Local only | HTTPS GET | Bitcoin node query |
| **Cost** | Free | Domain hosting (~$25/yr) | Inscription fee ($75-200) |
| **Mutability** | Immutable after creation | Mutable with version history | Immutable* |
| **Ownership Transfer** | Not supported | Domain transfer | Bitcoin transaction |
| **Provenance** | Creation only | Full version history | Immutable inscription |
| **Use Cases** | Experimentation, drafts | Public portfolios, discovery | High-value assets, sales |

*did:btco update semantics are implementation-dependent and MAY support updates via new inscriptions.

### 3.3 Asset Lifecycle

```
CREATE → PUBLISH → INSCRIBE → TRANSFER
  │         │          │           │
did:peer  did:webvh  did:btco   did:btco
          (optional)  (optional)  (optional)
```

**State Transitions:**
1. **CREATE**: Asset created with did:peer identifier (offline)
2. **PUBLISH**: Migrate to did:webvh (requires domain)
3. **INSCRIBE**: Migrate to did:btco (requires Bitcoin inscription)
4. **TRANSFER**: Transfer did:btco ownership (requires Bitcoin transaction)

**Invariants:**
- Migrations are unidirectional (cannot downgrade layers)
- Each migration preserves provenance via verifiable credentials
- Asset identity (DID) changes with each migration
- Previous layer DIDs remain resolvable (if published)

---

## 4. DID Method Specifications

### 4.1 did:peer (Offline Layer)

#### 4.1.1 Method Syntax

```
did:peer:4:<encoded-document>
```

**Grammar:**
```abnf
did-peer        = "did:peer:4:" encoded-doc
encoded-doc     = multibase-encoded-json
```

#### 4.1.2 Requirements

Originals Protocol implementations:
- MUST use Peer DID Method variant 4 (long-form, self-contained)
- MUST include at least one verification method
- MUST include authentication and assertionMethod relationships
- MUST use Multikey verification method type (not JsonWebKey2020)
- MUST support ES256K, Ed25519, or ES256 key types

#### 4.1.3 Example DID Document

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:peer:4:zQmXvR...",
  "verificationMethod": [{
    "id": "did:peer:4:zQmXvR...#key-1",
    "type": "Multikey",
    "controller": "did:peer:4:zQmXvR...",
    "publicKeyMultibase": "zDnaekGZT..."
  }],
  "authentication": ["did:peer:4:zQmXvR...#key-1"],
  "assertionMethod": ["did:peer:4:zQmXvR...#key-1"]
}
```

#### 4.1.4 Resolution

Peer DIDs MUST be resolved locally without network access:
1. Decode the DID suffix from multibase
2. Parse as JSON-LD DID document
3. Validate structure per DID Core spec
4. Return document or resolution error

#### 4.1.5 Provenance Recording

At creation, implementations SHOULD issue a self-attested creation credential:

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "OriginalsCreationCredential"],
  "issuer": "did:peer:4:zQmXvR...",
  "issuanceDate": "2025-11-18T12:00:00Z",
  "credentialSubject": {
    "id": "did:peer:4:zQmXvR...",
    "createdAt": "2025-11-18T12:00:00Z",
    "resources": [...]
  },
  "proof": { ... }
}
```

---

### 4.2 did:webvh (Web Layer)

#### 4.2.1 Method Syntax

```
did:webvh:<domain>:<path>
```

**Examples:**
```
did:webvh:example.com
did:webvh:example.com:alice
did:webvh:example.com:users:bob
```

#### 4.2.2 Requirements

Originals Protocol implementations:
- MUST comply with [DID:WEBVH Specification](https://identity.foundation/didwebvh/)
- MUST maintain version history as JSONL log
- MUST support HTTPS resolution via `.well-known/did.jsonl`
- MUST include creation timestamp and version ID in each log entry
- SHOULD support external signers for production deployments
- MAY support key pre-rotation for enhanced security

#### 4.2.3 Version History Log Format

The DID log MUST be a JSON Lines file where each line is a version entry:

```jsonl
{"versionId":"1-QmXvR","versionTime":"2025-11-18T12:00:00Z","parameters":{},"state":{...},"proof":[...]}
{"versionId":"2-QmYwS","versionTime":"2025-11-19T14:30:00Z","parameters":{},"state":{...},"proof":[...]}
```

**Log Entry Requirements:**
- `versionId`: REQUIRED - Unique monotonically increasing version identifier
- `versionTime`: REQUIRED - ISO 8601 timestamp of this version
- `parameters`: REQUIRED - Method-specific parameters (may be empty object)
- `state`: REQUIRED - Full DID document at this version
- `proof`: REQUIRED - Array of Data Integrity proofs signing this entry

#### 4.2.4 Resolution

To resolve `did:webvh:example.com:alice`:

1. Construct URL: `https://example.com/.well-known/did.jsonl` (base domain)
   OR: `https://example.com/alice/did.jsonl` (path-based)
2. Fetch via HTTPS GET (MUST validate TLS certificate)
3. Parse JSONL log (one JSON object per line)
4. Return the `state` from the last valid entry
5. Include version metadata in resolution metadata

#### 4.2.5 Migration from did:peer

When migrating from did:peer to did:webvh:

1. Generate or select a domain name
2. Create initial did:webvh log entry with:
   - New verification methods OR migrate existing keys
   - Service endpoint pointing to resources (optional)
   - `migratedFrom` property in DID document: `"did:peer:4:zQmXvR..."`
3. Sign log entry with keys authorized in did:peer document
4. Issue migration credential:

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "OriginalsMigrationCredential"],
  "issuer": "did:peer:4:zQmXvR...",
  "issuanceDate": "2025-11-18T12:00:00Z",
  "credentialSubject": {
    "id": "did:webvh:example.com:alice",
    "migratedFrom": "did:peer:4:zQmXvR...",
    "migratedAt": "2025-11-18T12:00:00Z",
    "layer": "did:webvh"
  },
  "proof": { ... }
}
```

---

### 4.3 did:btco (Bitcoin Layer)

#### 4.3.1 Method Syntax

```
did:btco:<satoshi-number>
```

**Example:**
```
did:btco:2099994106992659
```

where `2099994106992659` is the ordinal number of a specific satoshi.

#### 4.3.2 Requirements

Originals Protocol implementations:
- MUST use Bitcoin Ordinals theory for satoshi addressing
- MUST inscribe DID document as ordinal content
- MUST use CBOR encoding for inscription data
- MUST include content-type: `application/did+json` or `application/did+cbor`
- MUST validate satoshi number: 0 ≤ satoshi < 2,100,000,000,000,000

#### 4.3.3 DID Document Inscription

The DID document MUST be inscribed using Bitcoin's Ordinals protocol:

**Inscription Structure:**
```
OP_FALSE
OP_IF
  OP_PUSH "ord"
  OP_PUSH 1
  OP_PUSH "application/did+cbor"
  OP_PUSH 0
  OP_PUSH <cbor-encoded-did-document>
OP_ENDIF
```

**CBOR Encoding:**
- MUST use Concise Binary Object Representation (CBOR, RFC 8949)
- MUST preserve all DID document properties
- MAY use CBOR tags for optimization
- SHOULD compress if inscription size > 390KB (standardness limit)

#### 4.3.4 Resolution

To resolve `did:btco:2099994106992659`:

1. Query Bitcoin indexer for satoshi #2099994106992659
2. Identify the UTXO currently holding this satoshi
3. Retrieve inscription content from the UTXO
4. Decode CBOR to DID document
5. Validate DID document structure
6. Return document with resolution metadata:
   - `txid`: Transaction ID of inscription
   - `blockHeight`: Bitcoin block height
   - `confirmations`: Number of confirmations

**Resolution Metadata Example:**
```json
{
  "didDocument": { ... },
  "didResolutionMetadata": {
    "contentType": "application/did+cbor",
    "satoshi": "2099994106992659",
    "inscriptionId": "abc123...i0",
    "txid": "def456...",
    "blockHeight": 850000,
    "confirmations": 6
  }
}
```

#### 4.3.5 Ownership Transfer

Transferring ownership of a did:btco DID:

1. Identify the UTXO containing the inscribed satoshi
2. Create a Bitcoin transaction spending that UTXO
3. Send output to new owner's address
4. New owner controls the DID (controls the inscription)

**Provenance Credential:**
```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "OriginalsTransferCredential"],
  "issuer": "did:btco:2099994106992659",
  "issuanceDate": "2025-11-18T12:00:00Z",
  "credentialSubject": {
    "id": "did:btco:2099994106992659",
    "transferredTo": "bc1q...",  // Bitcoin address
    "transferredAt": "2025-11-18T12:00:00Z",
    "txid": "abc123..."
  },
  "proof": { ... }
}
```

#### 4.3.6 Migration from did:webvh

When migrating from did:webvh to did:btco:

1. Select target satoshi (usually newly created via commit-reveal)
2. Prepare DID document with:
   - `migratedFrom`: `"did:webvh:example.com:alice"`
   - New or migrated verification methods
   - Bitcoin-compatible verification methods (ES256K preferred)
3. Encode document as CBOR
4. Inscribe on selected satoshi
5. Issue migration credential (signed by did:webvh keys)

#### 4.3.7 Update Semantics

**Question for Working Group:** Should did:btco support updates?

**Option A - Immutable (RECOMMENDED):**
- did:btco DIDs are immutable after inscription
- Updates require new inscriptions with provenance links
- Preserves historical record perfectly

**Option B - Mutable:**
- New inscriptions on the same satoshi update the DID
- Resolution returns the latest inscription
- Enables key rotation and DID document updates

**Current Spec:** Option A (immutable). Updates require creating a new did:btco with provenance credential linking to the original.

---

## 5. Verifiable Credentials

### 5.1 General Requirements

All Originals Protocol credentials:
- MUST comply with [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
- MUST use JSON-LD format (not JWT)
- MUST include Data Integrity proofs (not JWS/JWT)
- MUST include `@context` with W3C VC context
- MUST have valid `issuer` DID (resolvable)
- MUST have valid `credentialSubject.id` DID (resolvable)
- SHOULD use EdDSA or BBS+ cryptosuites

### 5.2 Asset Creation Credential

**Type:** `OriginalsCreationCredential`

**Purpose:** Attest to the creation of an Original asset.

**Schema:**
```json
{
  "@context": [
    "https://www.w3.org/2018/credentials/v1",
    "https://originals.build/contexts/v1"
  ],
  "type": ["VerifiableCredential", "OriginalsCreationCredential"],
  "issuer": "<creator-did>",
  "issuanceDate": "<iso8601-timestamp>",
  "credentialSubject": {
    "id": "<asset-did>",
    "createdAt": "<iso8601-timestamp>",
    "resources": [
      {
        "id": "resource-1",
        "type": "image",
        "contentType": "image/png",
        "hash": "sha256:abc123...",
        "size": 1024000,
        "version": 1
      }
    ]
  },
  "proof": {
    "type": "EdDsaSignature2020",
    "created": "<iso8601-timestamp>",
    "verificationMethod": "<creator-did>#key-1",
    "proofPurpose": "assertionMethod",
    "proofValue": "zBase58-signature"
  }
}
```

**Required Fields:**
- `credentialSubject.id`: DID of the asset (did:peer at creation)
- `credentialSubject.createdAt`: Creation timestamp
- `credentialSubject.resources`: Array of resource descriptors

**Resource Descriptor:**
- `id`: REQUIRED - Logical resource identifier (stable across versions)
- `type`: REQUIRED - Resource type (image, text, code, data, etc.)
- `contentType`: REQUIRED - MIME type
- `hash`: REQUIRED - Content hash with algorithm prefix (sha256:, sha3-256:, etc.)
- `size`: OPTIONAL - Size in bytes
- `version`: OPTIONAL - Version number (default 1)
- `url`: OPTIONAL - Content location (HTTPS, IPFS, etc.)

### 5.3 Migration Credential

**Type:** `OriginalsMigrationCredential`

**Purpose:** Attest to the migration of an asset between layers.

**Schema:**
```json
{
  "@context": [
    "https://www.w3.org/2018/credentials/v1",
    "https://originals.build/contexts/v1"
  ],
  "type": ["VerifiableCredential", "OriginalsMigrationCredential"],
  "issuer": "<source-layer-did>",
  "issuanceDate": "<iso8601-timestamp>",
  "credentialSubject": {
    "id": "<target-layer-did>",
    "migratedFrom": "<source-layer-did>",
    "migratedAt": "<iso8601-timestamp>",
    "sourceLayer": "did:peer",
    "targetLayer": "did:webvh",
    "resources": [...],  // Carried forward from creation
    "previousCredential": "<hash-of-previous-credential>"
  },
  "proof": { ... }
}
```

**Layer Transitions:**
- `did:peer → did:webvh`: `issuer` is did:peer, `credentialSubject.id` is did:webvh
- `did:webvh → did:btco`: `issuer` is did:webvh, `credentialSubject.id` is did:btco

### 5.4 Transfer Credential

**Type:** `OriginalsTransferCredential`

**Purpose:** Attest to the transfer of ownership (Bitcoin layer only).

**Schema:**
```json
{
  "@context": [
    "https://www.w3.org/2018/credentials/v1",
    "https://originals.build/contexts/v1"
  ],
  "type": ["VerifiableCredential", "OriginalsTransferCredential"],
  "issuer": "<did:btco>",
  "issuanceDate": "<iso8601-timestamp>",
  "credentialSubject": {
    "id": "<did:btco>",
    "transferredFrom": "<seller-bitcoin-address>",
    "transferredTo": "<buyer-bitcoin-address>",
    "transferredAt": "<iso8601-timestamp>",
    "txid": "<bitcoin-transaction-id>",
    "blockHeight": 850000
  },
  "proof": { ... }
}
```

### 5.5 Credential Chains

Provenance is established through credential chains:

```
CreationCredential (did:peer)
        ↓
MigrationCredential (did:peer → did:webvh)
        ↓
MigrationCredential (did:webvh → did:btco)
        ↓
TransferCredential (did:btco ownership transfer)
```

**Requirements:**
- Each credential MUST reference the previous credential via `previousCredential` hash
- Hash MUST be computed over canonical JSON-LD representation
- Implementations MUST validate the entire chain for provenance verification

---

## 6. Lifecycle & Migration

### 6.1 State Machine

**States:**
- `CREATED`: Asset exists with did:peer identifier
- `PUBLISHED`: Asset migrated to did:webvh
- `INSCRIBED`: Asset migrated to did:btco
- `TRANSFERRED`: Asset ownership transferred (did:btco only)

**Transitions:**
```
     CREATE
        ↓
    CREATED ──PUBLISH──→ PUBLISHED ──INSCRIBE──→ INSCRIBED ──TRANSFER──→ TRANSFERRED
                                                       ↓                        ↓
                                                   TRANSFER ←───────────────────┘
                                                    (repeat)
```

### 6.2 Migration Validation Rules

#### 6.2.1 did:peer → did:webvh

**Pre-conditions:**
- Asset MUST be in `CREATED` state
- Asset MUST have valid did:peer DID document
- Asset MUST have creation credential

**Validation:**
1. Verify creation credential signature
2. Validate domain ownership (implementation-specific)
3. Verify key authorization (did:peer keys can sign for migration)
4. Check resource integrity (hash validation)

**Post-conditions:**
- Issue migration credential signed by did:peer keys
- Update state to `PUBLISHED`
- Preserve resource references

#### 6.2.2 did:webvh → did:btco

**Pre-conditions:**
- Asset MUST be in `PUBLISHED` state
- Asset MUST have valid did:webvh log
- Asset MUST have creation + migration credentials

**Validation:**
1. Verify entire credential chain
2. Validate did:webvh version history integrity
3. Verify key authorization for inscription
4. Estimate Bitcoin fees and confirm funding
5. Validate satoshi number selection

**Post-conditions:**
- Inscribe DID document on Bitcoin
- Issue migration credential signed by did:webvh keys
- Update state to `INSCRIBED`
- Wait for 6 confirmations (RECOMMENDED)

#### 6.2.3 Ownership Transfer (did:btco only)

**Pre-conditions:**
- Asset MUST be in `INSCRIBED` or `TRANSFERRED` state
- Transferor MUST control the UTXO containing the inscription
- Valid recipient Bitcoin address

**Validation:**
1. Verify UTXO ownership
2. Construct transfer transaction
3. Sign with private key controlling UTXO
4. Broadcast to Bitcoin network

**Post-conditions:**
- Issue transfer credential (optional, off-chain)
- Update state to `TRANSFERRED`
- New owner resolves did:btco to verify ownership

### 6.3 Rollback & Recovery

**General Principle:** Migrations are atomic at the protocol level but MAY fail at the infrastructure level.

**Rollback Scenarios:**

1. **did:webvh publication fails (domain unavailable):**
   - Asset remains in `CREATED` state
   - No credentials issued
   - Retry with different domain

2. **did:btco inscription fails (Bitcoin tx rejected):**
   - Asset remains in `PUBLISHED` state
   - Migration credential not issued
   - Retry with different fee rate or satoshi

3. **Partial state corruption:**
   - Implementations SHOULD maintain checkpoints before migrations
   - Rollback to last valid checkpoint
   - Re-execute migration with corrected parameters

**No Downgrades:** Once a migration credential is issued, the asset CANNOT return to a previous layer.

---

## 7. Bitcoin Integration

### 7.1 Commit-Reveal Inscription Pattern

To prevent front-running and ensure satoshi uniqueness:

**Commit Transaction:**
1. Create a transaction output with minimal value (e.g., 546 sats)
2. Send to a unique address derived from inscription content hash
3. Wait for 1+ confirmations

**Reveal Transaction:**
1. Spend the commit output
2. Include inscription in witness data
3. Create output with inscribed satoshi
4. Broadcast reveal transaction

**Benefits:**
- Inscription content hidden until reveal
- Satoshi assignment deterministic
- Front-running protection

### 7.2 UTXO Selection for Inscriptions

**Requirements:**
- MUST NOT spend UTXOs containing existing inscriptions (unless explicitly transferring)
- SHOULD minimize transaction fees via optimal UTXO selection
- SHOULD prefer UTXOs with values close to required amount
- MUST account for ordinal-aware UTXO tracking

**Algorithm (simplified):**
```
function selectUtxos(requiredAmount, feeRate, availableUtxos):
  nonInscribedUtxos = filter(availableUtxos, utxo => !utxo.inscriptions)
  sort(nonInscribedUtxos by value ascending)

  selected = []
  total = 0

  for utxo in nonInscribedUtxos:
    selected.push(utxo)
    total += utxo.value

    estimatedFee = calculateFee(selected.length, feeRate)
    if total >= requiredAmount + estimatedFee:
      return selected

  throw InsufficientFundsError
```

### 7.3 Fee Estimation

**Recommended Fee Rates:**
- **Testnet:** 1-5 sats/vbyte
- **Mainnet (low priority):** 10-20 sats/vbyte
- **Mainnet (standard):** 20-50 sats/vbyte
- **Mainnet (high priority):** 50-200+ sats/vbyte

**Dynamic Fee Estimation:**
Implementations SHOULD query fee estimation APIs:
- https://mempool.space/api/v1/fees/recommended
- Bitcoin Core `estimatesmartfee` RPC
- Custom fee oracle adapters

**Inscription Cost Estimate:**
```
Total Cost = (Base Tx Size + Inscription Size) × Fee Rate + Padding

Where:
  Base Tx Size ≈ 250 vbytes (2 inputs, 2 outputs)
  Inscription Size = Witness data size (DID document CBOR)
  Fee Rate = sats/vbyte from fee estimation
  Padding = 10-20% buffer for variability
```

### 7.4 Confirmation Requirements

**Minimum Confirmations:**
- **Testnet:** 1 confirmation acceptable
- **Mainnet (< $1000 value):** 1-3 confirmations
- **Mainnet ($1000-$10000):** 3-6 confirmations
- **Mainnet (> $10000):** 6+ confirmations

Implementations SHOULD allow configurable confirmation thresholds.

### 7.5 Network Support

Implementations MUST support:
- **Mainnet** (production)
- **Testnet** (public testing)

Implementations MAY support:
- **Signet** (developer testing)
- **Regtest** (local development)

---

## 8. Cryptographic Requirements

### 8.1 Key Types

**REQUIRED Support:**
- **ES256K** (secp256k1) - Bitcoin compatibility
- **Ed25519** - High performance, small signatures

**OPTIONAL Support:**
- **ES256** (secp256r1 / NIST P-256) - Enterprise compatibility

### 8.2 Key Encoding

**Format:** Multikey (multibase + multicodec)

**Public Key Example:**
```
z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
│ └─────────────────┬──────────────────────┘
│              base58btc encoded
└─ multibase prefix (z = base58btc)
```

**Private Key Example:**
```
zrv1PthvuP2xXrcqoxYdQ9fGMPjVpwFb4MHTvj9w7KCVqNMVFy
│ └──────────────────────┬───────────────────────┘
│                 base58btc encoded
└─ multibase prefix for private key
```

**Prohibited:** JSON Web Keys (JWK) format is NOT used in the Originals Protocol.

### 8.3 Signature Schemes

#### 8.3.1 EdDSA (Ed25519)

**Cryptosuite:** `EdDsaSignature2020`

**Libraries:**
- `@stablelib/ed25519`
- `@noble/ed25519`

**Proof Example:**
```json
{
  "type": "EdDsaSignature2020",
  "created": "2025-11-18T12:00:00Z",
  "verificationMethod": "did:peer:4:zQmXvR...#key-1",
  "proofPurpose": "assertionMethod",
  "proofValue": "zBase58-encoded-64-byte-signature"
}
```

#### 8.3.2 BBS+ (Selective Disclosure)

**Cryptosuite:** `BbsBlsSignature2020`

**Use Case:** Privacy-preserving credentials with selective disclosure.

**Proof Example:**
```json
{
  "type": "BbsBlsSignature2020",
  "created": "2025-11-18T12:00:00Z",
  "verificationMethod": "did:webvh:example.com#key-2",
  "proofPurpose": "assertionMethod",
  "proofValue": "zBase58-encoded-bbs-signature"
}
```

### 8.4 Hash Functions

**REQUIRED:**
- **SHA-256** - Bitcoin compatibility, content hashing

**OPTIONAL:**
- **SHA3-256** - Alternative content hashing
- **BLAKE3** - High performance hashing

**Content Hash Format:**
```
<algorithm>:<hex-encoded-hash>

Examples:
  sha256:abc123...
  sha3-256:def456...
  blake3:789ghi...
```

### 8.5 Canonicalization

**JSON-LD Canonicalization:**
- MUST use [RDF Dataset Canonicalization (RDFC-1.0)](https://www.w3.org/TR/rdf-canon/)
- Required for consistent credential hashing
- Required for signature verification

**CBOR Canonicalization:**
- MUST use deterministic CBOR encoding (RFC 8949 Section 4.2)
- Required for Bitcoin inscriptions
- Shortest encoding for integers
- Sorted map keys

---

## 9. Interoperability

### 9.1 W3C Compliance

**DID Core:**
- MUST comply with [W3C DID Core 1.0](https://www.w3.org/TR/did-core/)
- MUST support DID resolution
- MUST return standard resolution metadata

**Verifiable Credentials:**
- MUST comply with [W3C VC Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
- MUST support Data Integrity proofs
- MUST support credential verification

### 9.2 JSON-LD Contexts

**Originals Context:**
```
https://originals.build/contexts/v1
```

**Context Document:**
```json
{
  "@context": {
    "OriginalsCreationCredential": "https://originals.build/vocab#OriginalsCreationCredential",
    "OriginalsMigrationCredential": "https://originals.build/vocab#OriginalsMigrationCredential",
    "OriginalsTransferCredential": "https://originals.build/vocab#OriginalsTransferCredential",
    "resources": "https://originals.build/vocab#resources",
    "migratedFrom": "https://originals.build/vocab#migratedFrom",
    "migratedAt": { "@id": "https://originals.build/vocab#migratedAt", "@type": "http://www.w3.org/2001/XMLSchema#dateTime" }
  }
}
```

**Context Hosting:**
- MUST be served via HTTPS
- SHOULD use content-addressable URLs (IPFS fallback)
- MUST support CORS for browser access
- SHOULD cache with long TTL

### 9.3 Cross-Implementation Compatibility

**Test Vectors:**
Implementations SHOULD pass a reference test suite including:
- DID resolution for all three methods
- Credential issuance and verification
- Migration credential validation
- Provenance chain verification

**Compatibility Matrix:**
| Implementation | did:peer | did:webvh | did:btco | Migration | Transfer |
|----------------|----------|-----------|----------|-----------|----------|
| Reference SDK (TypeScript) | ✅ | ✅ | ✅ | ✅ | ✅ |
| (Future: Rust) | - | - | - | - | - |
| (Future: Go) | - | - | - | - | - |

---

## 10. Security Considerations

### 10.1 Key Management

**Private Key Storage:**
- MUST store private keys encrypted at rest
- SHOULD use hardware security modules (HSMs) for high-value assets
- SHOULD support external signers (Turnkey, AWS KMS, etc.)
- MUST NOT log or transmit private keys in plaintext

**Key Rotation:**
- did:peer: Not supported (immutable)
- did:webvh: Supported via version log updates
- did:btco: Implementation-dependent (see Section 4.3.7)

**Compromised Keys:**
- did:webvh: Update log with new keys, mark old keys as revoked
- did:btco: Transfer to new inscription with fresh keys

### 10.2 DID Resolution Security

**did:webvh:**
- MUST validate HTTPS certificates
- MUST reject self-signed certificates in production
- SHOULD implement certificate pinning for high-security applications
- MUST verify log entry signatures

**did:btco:**
- MUST validate Bitcoin block confirmations
- SHOULD wait for 6+ confirmations for high-value assets
- MUST verify inscription integrity
- SHOULD use multiple Bitcoin nodes for resolution (avoid single point of failure)

### 10.3 Credential Verification

**Signature Verification:**
- MUST verify all proofs in credential chain
- MUST resolve issuer DID and validate verification method
- MUST check proof purpose matches credential type
- SHOULD implement replay attack protection (nonce, timestamp validation)

**Revocation:**
- did:webvh: Check DID document for revoked keys
- did:btco: Check if inscription still held by claimed owner

### 10.4 Bitcoin-Specific Risks

**Front-Running:**
- Mitigated by commit-reveal pattern
- Implementations MUST use commit-reveal for inscriptions

**Fee Sniping:**
- Use appropriate fee rates for target confirmation time
- Monitor mempool for stuck transactions

**Reorg Attacks:**
- Wait for sufficient confirmations (6+ recommended)
- Monitor for chain reorganizations

**Dust Attacks:**
- Reject UTXOs below dust limit (546 sats)
- Validate all UTXO sources

### 10.5 Threat Model

**Adversary Capabilities:**
- Network-level attacker (MitM, DNS hijacking)
- Compromised web server (did:webvh)
- Blockchain reorg (did:btco, < 6 confirmations)
- Social engineering (key theft)

**Protections:**
- HTTPS with certificate validation (did:webvh)
- Bitcoin confirmations (did:btco)
- Multi-signature requirements (optional extension)
- External signer integration

---

## 11. Privacy Considerations

### 11.1 Layer Privacy Characteristics

| Layer | Privacy Level | Considerations |
|-------|---------------|----------------|
| **did:peer** | High | Fully offline, not publicly discoverable |
| **did:webvh** | Medium | Public HTTPS hosting, discoverable via domain |
| **did:btco** | Low | Permanent public record on Bitcoin blockchain |

### 11.2 Pseudonymity

**did:webvh:**
- Domain names MAY reveal identity
- Consider privacy-preserving domains (e.g., random subdomains)

**did:btco:**
- Bitcoin addresses are pseudonymous
- Blockchain analysis can link addresses
- Consider using fresh addresses for each inscription
- Consider CoinJoin or Lightning for enhanced privacy

### 11.3 Selective Disclosure

**Use BBS+ Credentials:**
- Enable selective disclosure of credential attributes
- Reveal only necessary information (e.g., "created after 2025" without exact date)
- Protect resource metadata from full disclosure

**Example:**
```json
{
  "type": ["VerifiableCredential", "OriginalsCreationCredential"],
  "credentialSubject": {
    "id": "did:btco:123456789",
    "createdAfter": "2025-01-01",  // Disclosed
    "resources": { ... }  // Hidden via BBS+ proof
  }
}
```

### 11.4 Data Minimization

**Recommendations:**
- Store only content hashes on-chain, not full content
- Use IPFS or content-addressable storage for large resources
- Include minimal personal information in DID documents
- Use service endpoints instead of embedded data

---

## 12. References

### 12.1 Normative References

- [RFC 2119] - Key words for use in RFCs to Indicate Requirement Levels
- [DID-CORE] - Decentralized Identifiers (DIDs) v1.0, W3C Recommendation
- [VC-DATA-MODEL] - Verifiable Credentials Data Model v2.0, W3C Recommendation
- [DID-PEER] - Peer DID Method Specification
- [DID-WEBVH] - did:webvh Method Specification
- [RFC 8949] - Concise Binary Object Representation (CBOR)
- [RDF-CANON] - RDF Dataset Canonicalization

### 12.2 Informative References

- Bitcoin Ordinals Theory: https://docs.ordinals.com/
- Multicodec: https://github.com/multiformats/multicodec
- Multibase: https://github.com/multiformats/multibase
- BIP 32: Hierarchical Deterministic Wallets
- BIP 340: Schnorr Signatures for secp256k1

### 12.3 Additional Resources

- Originals SDK (TypeScript): https://github.com/aviarytech/originals-sdk
- Originals Protocol Website: https://originals.build
- Community Forum: TBD
- Working Group: TBD

---

## Appendix A: Example Workflows

### A.1 Create and Migrate to Bitcoin

```typescript
// 1. Create asset (did:peer)
const resources = [{
  id: 'artwork-v1',
  type: 'image',
  contentType: 'image/png',
  hash: 'sha256:abc123...',
  size: 2048000
}];

const asset = await sdk.lifecycle.createAsset(resources);
// asset.id = "did:peer:4:zQmXvR..."

// 2. Publish to web (did:webvh)
await sdk.lifecycle.publishToWeb(asset, 'gallery.example.com');
// asset.id = "did:webvh:gallery.example.com:zQmXvR"

// 3. Inscribe on Bitcoin (did:btco)
const inscription = await sdk.lifecycle.inscribeOnBitcoin(asset);
// asset.id = "did:btco:2099994106992659"

// 4. Verify provenance
const provenance = await asset.getProvenance();
// Returns: [CreationCredential, MigrationCredential (→webvh), MigrationCredential (→btco)]

// 5. Transfer ownership
await sdk.lifecycle.transferOwnership(asset, 'bc1q...');
```

### A.2 Verify Asset Authenticity

```typescript
// Resolve DID
const didDocument = await sdk.did.resolveDID('did:btco:2099994106992659');

// Get provenance credentials
const provenance = await sdk.lifecycle.getProvenanceChain('did:btco:2099994106992659');

// Verify each credential
for (const credential of provenance) {
  const isValid = await sdk.credentials.verify(credential);
  console.log(`Credential ${credential.type}: ${isValid ? 'VALID' : 'INVALID'}`);
}

// Check resource integrity
const resource = didDocument.resources[0];
const actualHash = computeHash(fetchResource(resource.url));
const expectedHash = resource.hash;
console.log(`Resource integrity: ${actualHash === expectedHash ? 'VALID' : 'INVALID'}`);
```

---

## Appendix B: Open Questions for Working Group

1. **did:btco Update Semantics:**
   - Should did:btco support updates via new inscriptions?
   - Or should updates require new DIDs with provenance links?

2. **Resource Storage:**
   - Should the spec recommend specific storage solutions (IPFS, Arweave)?
   - Or remain agnostic to storage layer?

3. **Marketplace Integration:**
   - Should the spec define transfer protocols beyond Bitcoin txs?
   - E.g., escrow patterns, atomic swaps, payment channels?

4. **Governance:**
   - How should the spec be maintained and versioned?
   - Who decides on extensions and updates?

5. **Backward Compatibility:**
   - How will v2.0 changes affect v1.0 assets?
   - Migration path for protocol upgrades?

---

## Appendix C: Change Log

- **v1.0.0-draft.1** (2025-11-18):
  - Initial draft specification
  - Three DID method definitions
  - Credential schemas
  - Migration rules
  - Bitcoin integration patterns

---

## Appendix D: Acknowledgments

This specification builds upon:
- W3C DID Working Group
- W3C Verifiable Credentials Working Group
- Bitcoin Ordinals community
- DIF (Decentralized Identity Foundation)
- The developers and contributors of the Originals SDK

---

**END OF SPECIFICATION**

*This is a DRAFT specification. Comments and contributions are welcome via GitHub Issues or the community forum.*
