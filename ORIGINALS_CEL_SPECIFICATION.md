# Originals Protocol — CEL Application Specification v2.0

**Status:** Draft  
**Version:** 2.0  
**Authors:** Brian + Krusty  
**Date:** 2026-01-30  
**Based On:** [W3C CCG Cryptographic Event Log v0.1](https://github.com/w3c-ccg/cel-spec)

---

## Abstract

This document defines the **Originals CEL Application Specification**, an extension of the W3C CCG [Cryptographic Event Log (CEL)](https://github.com/w3c-ccg/cel-spec) specification for managing digital asset provenance across three infrastructure layers. It specifies how Originals uses CEL as a universal event format while employing different DID methods (`did:peer`, `did:webvh`, `did:btco`) for resolvability at each stage of an asset's lifecycle.

---

## 1. Introduction

### 1.1 Background

The Cryptographic Event Log (CEL) specification, developed by Digital Bazaar and the W3C Credentials Community Group, provides a data model for expressing changes to data over time in a tamper-evident manner that can be cryptographically authenticated by verifiers in a decentralized way.

CEL is designed to be extended by **Application Specifications** that define:
1. How cryptographic control is asserted over operations
2. How current state is built from the sequence of events
3. How witness proofs are validated

This document defines the **Originals CEL Application Specification**, which builds upon the base CEL specification to support digital asset provenance with progressive decentralization.

### 1.2 Design Goals

The Originals protocol satisfies the following requirements:

| Goal | Description |
|------|-------------|
| **Progressive Decentralization** | Assets begin offline and can migrate through increasingly permanent infrastructure |
| **Portable Provenance** | Complete event history travels with the asset across layers |
| **Cryptographic Continuity** | Migration events create verifiable links between DID identities |
| **Witness Flexibility** | Different witness types appropriate to each layer |
| **Content Integrity** | Media and metadata secured via content-addressed references |

### 1.3 Relationship to Base CEL Specification

This specification extends CEL by defining:
- The `migrate` operation type (in addition to `create`, `update`, `deactivate`)
- Layer-specific witness requirements and validation rules
- Content addressing conventions for digital assets
- DID document structures for each layer
- Migration semantics between layers

---

## 2. Three-Layer Architecture

### 2.1 Overview

Originals assets progress through three infrastructure layers, each providing different properties:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ORIGINALS LIFECYCLE                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Layer 1: PRIVATE          Layer 2: PUBLIC           Layer 3: PERMANENT │
│   ─────────────────         ──────────────            ────────────────── │
│                                                                         │
│   ┌─────────────┐          ┌─────────────┐          ┌─────────────┐    │
│   │  did:peer   │ ──────▶  │  did:webvh  │ ──────▶  │  did:btco   │    │
│   └─────────────┘  migrate └─────────────┘  migrate └─────────────┘    │
│         │                        │                        │             │
│   ┌─────▼─────┐            ┌─────▼─────┐            ┌─────▼─────┐      │
│   │    CEL    │            │    CEL    │            │    CEL    │      │
│   │   (log)   │────────────│   (log)   │────────────│   (log)   │      │
│   └───────────┘  carried   └───────────┘  carried   └───────────┘      │
│                  forward                  forward                       │
│   • Offline                • Web-hosted              • Bitcoin-anchored │
│   • Self-witnessed         • Server witnesses        • Ordinal witness  │
│   • Free                   • Hosting costs           • Miner fees       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Layer Comparison

| Property | Layer 1: `did:peer` | Layer 2: `did:webvh` | Layer 3: `did:btco` |
|----------|---------------------|----------------------|---------------------|
| **Resolution** | Self-contained (requires log) | HTTPS endpoint | Bitcoin/Ordinals lookup |
| **Discovery** | Out-of-band sharing | Web discoverable | Publicly discoverable |
| **Witness Type** | Self-signed | Web server attestation | Bitcoin block timestamp |
| **Permanence** | Ephemeral (file-based) | Server-dependent | Immutable |
| **Cost** | Free | Hosting fees | Transaction fees |
| **Typical Use** | Creation, drafts | Publishing, trading | Permanent anchoring |

### 2.3 DID Method Selection Rationale

**Why not `did:cel`?**

A content-addressed DID (like `did:cel`) would be unresolvable without access to the event log itself. By using distinct DID methods for each layer, Originals provides:

1. **Layer-appropriate resolution**: Each DID method has its own resolution mechanism
2. **Progressive trust**: Assets gain stronger guarantees as they migrate
3. **Interoperability**: Standard DID resolution at each layer

---

## 3. CEL Data Model

### 3.1 Event Log Structure

An Originals CEL event log conforms to the base CEL specification with the following structure:

```json
{
  "log": [
    {
      "event": {
        "operation": {
          "type": "create | update | migrate | deactivate",
          "data": { },
          "dataReference": { }
        },
        "previousEvent": "<multibase-multihash>"
      },
      "proof": [
        { "type": "DataIntegrityProof", ... },
        { "type": "DataIntegrityProof", ... }
      ]
    }
  ],
  "previousLog": {
    "url": ["https://...", "ipfs://..."],
    "mediaType": "application/cel+json",
    "digestMultibase": "<multibase-multihash>",
    "proof": [...]
  }
}
```

### 3.2 Content Addressing

All content references in Originals use the CEL **External Reference** format:

```json
{
  "url": [
    "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    "https://cdn.example.com/assets/abc123.png",
    "ar://0x1234567890abcdef..."
  ],
  "mediaType": "image/png",
  "digestMultibase": "uEiC5TSe5k00TwGnPnRs25nAOGsSm4GIny2HW_Nml0ekzLA"
}
```

**Properties:**

| Property | Required | Description |
|----------|----------|-------------|
| `url` | Optional | Array of URLs for content retrieval (IPFS, HTTPS, Arweave, Onion) |
| `mediaType` | Optional | IANA media type (RFC 6838) |
| `digestMultibase` | **Required** | Multibase-encoded (base64-url-nopad) Multihash (sha2-256) |

**Digest Computation:**

```
digestMultibase = multibase_encode(
  "u",  // base64-url-nopad prefix
  multihash(
    0x12,  // sha2-256 codec
    sha256(content_bytes)
  )
)
```

### 3.3 Operation Types

#### 3.3.1 Create Operation

Creates a new Original asset. This is always the first event in a log.

```json
{
  "event": {
    "operation": {
      "type": "create",
      "data": {
        "@context": [
          "https://www.w3.org/ns/credentials/v2",
          "https://originals.onion/ns/v1"
        ],
        "type": ["Original"],
        "creator": "did:peer:2.Ez6LSbysY...",
        "created": "2026-01-30T12:00:00Z",
        "content": {
          "url": ["ipfs://Qm...", "https://..."],
          "mediaType": "image/png",
          "digestMultibase": "uEiC5TSe5k00TwGnPnRs..."
        },
        "metadata": {
          "name": "Genesis Creation",
          "description": "The first piece in the collection",
          "attributes": [
            { "trait_type": "Edition", "value": "1 of 1" }
          ]
        },
        "proof": {
          "type": "DataIntegrityProof",
          "cryptosuite": "eddsa-jcs-2022",
          "created": "2026-01-30T12:00:00Z",
          "verificationMethod": "did:peer:2.Ez6LSbysY...#key-1",
          "proofPurpose": "assertionMethod",
          "proofValue": "z5vgFc..."
        }
      }
    }
  },
  "proof": [...]
}
```

**Required Fields:**
- `creator`: DID of the creating entity (establishes cryptographic control)
- `created`: ISO 8601 timestamp
- `content`: External reference to the primary media
- `proof`: Data Integrity Proof from a key in the creator's DID document

#### 3.3.2 Update Operation

Modifies the asset's metadata or adds supplementary content.

```json
{
  "event": {
    "previousEvent": "uEiAkoYyQ6YVtUmER8pN24wLZcLK9EBguM5WZlbAgfXBDuQ",
    "operation": {
      "type": "update",
      "data": {
        "metadata": {
          "name": "Genesis Creation (Revised)",
          "revision": 2
        },
        "supplementaryContent": [
          {
            "label": "High-resolution archive",
            "url": ["ipfs://Qm..."],
            "mediaType": "image/tiff",
            "digestMultibase": "uEiD..."
          }
        ],
        "proof": {
          "type": "DataIntegrityProof",
          "cryptosuite": "eddsa-jcs-2022",
          "verificationMethod": "did:peer:2.Ez6LSbysY...#key-1",
          "proofPurpose": "assertionMethod",
          "proofValue": "z4Kj..."
        }
      }
    }
  },
  "proof": [...]
}
```

**Validation:**
- `previousEvent` MUST match the hash of the immediately preceding event
- `proof.verificationMethod` MUST be authorized by the current controller

#### 3.3.3 Migrate Operation

Records transition between infrastructure layers. This is an Originals-specific extension to CEL.

```json
{
  "event": {
    "previousEvent": "uEiAkoYyQ6YVtUmER8pN24wLZcLK9EBguM5WZlbAgfXBDuQ",
    "operation": {
      "type": "migrate",
      "data": {
        "migration": {
          "fromDid": "did:peer:2.Ez6LSbysY2MkESH3bDt1vrKKKzLYfRoQqpvVdBPPUCUtwFSv3",
          "toDid": "did:webvh:originals.example:assets:abc123",
          "fromLayer": 1,
          "toLayer": 2,
          "reason": "publish",
          "timestamp": "2026-01-30T14:00:00Z"
        },
        "didDocument": {
          "@context": ["https://www.w3.org/ns/did/v1"],
          "id": "did:webvh:originals.example:assets:abc123",
          "controller": "did:webvh:originals.example:users:alice",
          "verificationMethod": [...],
          "service": [{
            "id": "did:webvh:originals.example:assets:abc123#cel",
            "type": "CryptographicEventLog",
            "serviceEndpoint": "https://originals.example/.well-known/cel/assets/abc123.json"
          }]
        },
        "proof": {
          "type": "DataIntegrityProof",
          "cryptosuite": "eddsa-jcs-2022",
          "verificationMethod": "did:peer:2.Ez6LSbysY...#key-1",
          "proofPurpose": "assertionMethod",
          "proofValue": "z3mN..."
        }
      }
    }
  },
  "proof": [...]
}
```

**Migration Semantics:**

1. **Continuity**: The migration event is signed by the outgoing DID's controller
2. **Link**: `fromDid` and `toDid` create a verifiable chain of identity
3. **DID Document**: The new layer's DID document is embedded or referenced
4. **Service Endpoint**: Specifies where the CEL can be resolved at the new layer

**Valid Migration Paths:**

| From | To | Reason |
|------|-----|--------|
| Layer 1 (`did:peer`) | Layer 2 (`did:webvh`) | `publish`, `trade`, `backup` |
| Layer 1 (`did:peer`) | Layer 3 (`did:btco`) | `anchor` (direct inscription) |
| Layer 2 (`did:webvh`) | Layer 3 (`did:btco`) | `anchor`, `permanence` |

**Note:** Migrations are one-way. Once anchored to Bitcoin, the asset cannot migrate back.

#### 3.3.4 Deactivate Operation

Permanently marks the log as final. No further events may be appended.

```json
{
  "event": {
    "previousEvent": "uEiAkoYyQ6YVtUmER8pN24wLZcLK9EBguM5WZlbAgfXBDuQ",
    "operation": {
      "type": "deactivate",
      "data": {
        "reason": "burned",
        "finalState": "destroyed",
        "proof": {
          "type": "DataIntegrityProof",
          "cryptosuite": "eddsa-jcs-2022",
          "verificationMethod": "did:btco:abc123...#key-1",
          "proofPurpose": "assertionMethod",
          "proofValue": "z9Xk..."
        }
      }
    }
  },
  "proof": [...]
}
```

**Deactivation Reasons:**
- `burned`: Asset intentionally destroyed
- `superseded`: Replaced by another asset (reference in metadata)
- `revoked`: Deemed invalid or fraudulent by issuer
- `expired`: Time-limited asset reached end of life

---

## 4. Event Chain Validation

### 4.1 Hash Chain Verification

The event log forms a hash chain where each event (except the first) references the previous:

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ create   │────▶│ update   │────▶│ migrate  │────▶│ update   │
│          │     │          │     │          │     │          │
│ prev: ∅  │     │ prev: H1 │     │ prev: H2 │     │ prev: H3 │
│ hash: H1 │     │ hash: H2 │     │ hash: H3 │     │ hash: H4 │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

**Hash Computation:**

```python
def compute_event_hash(event):
    # 1. Serialize event to canonical JSON (JCS - RFC 8785)
    canonical = jcs_canonicalize(event)
    
    # 2. Compute SHA-256 hash
    digest = sha256(canonical)
    
    # 3. Encode as Multihash
    multihash = bytes([0x12, len(digest)]) + digest
    
    # 4. Encode as Multibase (base64-url-nopad)
    return "u" + base64url_encode(multihash)
```

### 4.2 Verification Algorithm

```
Algorithm: Verify Originals Event Log

Input: eventLog (the CEL to verify)
Output: { valid: boolean, currentState: object, errors: array }

1. Let errors = []
2. Let previousHash = null
3. Let controller = null
4. Let layer = 1
5. Let deactivated = false

6. For each entry in eventLog.log:
   a. If deactivated:
      - errors.push("Event after deactivation")
      - continue
      
   b. Let event = entry.event
   
   c. If event.operation.type == "create":
      - If previousHash != null:
        errors.push("Create must be first event")
      - controller = event.operation.data.creator
      
   d. Else:
      - If event.previousEvent != previousHash:
        errors.push("Hash chain broken at event " + index)
        
   e. Verify data proof:
      - If event.operation.data.proof:
        - Verify proof.verificationMethod is authorized by controller
        - Verify proof.proofValue over operation.data
        
   f. Verify witness proofs:
      - For each proof in entry.proof:
        - Verify proof against layer-appropriate witness rules
        
   g. Handle operation type:
      - If "update": Apply state changes
      - If "migrate": 
        - Verify migration.fromDid matches current controller
        - controller = migration.toDid
        - layer = migration.toLayer
      - If "deactivate": deactivated = true
      
   h. previousHash = compute_event_hash(event)

7. Return { valid: errors.length == 0, errors, currentState }
```

### 4.3 Fork Detection

A fork occurs when two different events claim the same `previousEvent`:

```
             ┌──────────┐
       ┌────▶│ update A │  ← Fork!
       │     └──────────┘
┌──────┴───┐
│ create   │
└──────┬───┘
       │     ┌──────────┐
       └────▶│ update B │  ← Fork!
             └──────────┘
```

**Detection:**
- Verifiers SHOULD cache witnessed event hashes
- If a new event's `previousEvent` matches a cached hash but the new event differs, a fork is detected
- Layer 2 and 3 witnesses help prevent undetected forks

---

## 5. Witness System

### 5.1 Witness Proof Structure

Witness proofs use the W3C Data Integrity format:

```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "ecdsa-jcs-2019",
  "created": "2026-01-30T12:00:05Z",
  "verificationMethod": "https://witness.example/keys#attestation-1",
  "proofPurpose": "assertionMethod",
  "proofValue": "zJdq6PrUMCtqY5obCSsrQxuF..."
}
```

### 5.2 Layer-Specific Witness Requirements

#### Layer 1: Self-Witness (did:peer)

At Layer 1, the controller acts as their own witness:

```json
{
  "proof": [{
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-jcs-2022",
    "created": "2026-01-30T12:00:00Z",
    "verificationMethod": "did:peer:2.Ez6LSbysY...#key-1",
    "proofPurpose": "assertionMethod",
    "proofValue": "z5vgFc..."
  }]
}
```

**Validation:**
- At least one proof from the controller's DID
- Proof establishes creation time (trusted by the creator only)

#### Layer 2: Web Witness (did:webvh)

At Layer 2, the hosting server provides additional witness attestation:

```json
{
  "proof": [
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "verificationMethod": "did:peer:2.Ez6LSbysY...#key-1",
      "proofValue": "z5vgFc..."
    },
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "ecdsa-jcs-2019",
      "created": "2026-01-30T12:00:02Z",
      "verificationMethod": "https://originals.example/.well-known/did.json#witness-key",
      "proofPurpose": "assertionMethod",
      "proofValue": "zQxuF5obC..."
    }
  ]
}
```

**Validation:**
- Controller proof (required)
- Server witness proof (recommended)
- Multiple independent witnesses (optional, increases trust)

#### Layer 3: Bitcoin Witness (did:btco)

At Layer 3, the Bitcoin blockchain provides the ultimate timestamp witness:

```json
{
  "proof": [
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "verificationMethod": "did:btco:abc123...#key-1",
      "proofValue": "z5vgFc..."
    },
    {
      "type": "BitcoinTimestampProof",
      "created": "2026-01-30T12:00:00Z",
      "verificationMethod": "btc:block:876543",
      "inscription": {
        "id": "abc123i0",
        "txid": "abc123...",
        "vout": 0,
        "sat": 1234567890,
        "contentHash": "uEiC5TSe5k00..."
      },
      "proofValue": "merkle:root:path..."
    }
  ]
}
```

**Bitcoin Witness Properties:**

| Field | Description |
|-------|-------------|
| `inscription.id` | Ordinal inscription ID |
| `inscription.txid` | Bitcoin transaction ID |
| `inscription.sat` | Satoshi number (ordinal) |
| `inscription.contentHash` | Hash of inscribed content |

### 5.3 Witness Trust Model

Verifiers establish trust based on context:

```
Trust Level = f(controller_proof, witness_diversity, layer)

Where:
- Controller proof is always required
- More diverse witnesses increase confidence
- Higher layers provide stronger guarantees
```

**Recommended Witness Strategy:**

| Scenario | Recommended Witnesses |
|----------|----------------------|
| Personal archive | Self-witness sufficient |
| Public gallery | 2+ independent web witnesses |
| High-value trade | Web witness + Bitcoin timestamp |
| Permanent record | Full Bitcoin anchoring |

---

## 6. Layer-Specific DID Documents

### 6.1 Layer 1: did:peer

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:peer:2.Ez6LSbysY2MkESH3bDt1vrKKKzLYfRoQqpvVdBPPUCUtwFSv3.Vz6MkgoLTnTypo3tDRwCkZXSccTPHRLhF4ZnjhueYAFpEYyAo",
  "verificationMethod": [{
    "id": "#key-1",
    "type": "Multikey",
    "controller": "did:peer:2.Ez6LSbysY2MkESH3bDt1vrKKKzLYfRoQqpvVdBPPUCUtwFSv3.Vz6MkgoLTnTypo3tDRwCkZXSccTPHRLhF4ZnjhueYAFpEYyAo",
    "publicKeyMultibase": "z6MkgoLTnTypo3tDRwCkZXSccTPHRLhF4ZnjhueYAFpEYyAo"
  }],
  "authentication": ["#key-1"],
  "assertionMethod": ["#key-1"],
  "service": [{
    "id": "#cel",
    "type": "CryptographicEventLog",
    "serviceEndpoint": "embedded"
  }]
}
```

**Notes:**
- Uses did:peer numalgo 2 (self-certifying)
- Service endpoint is "embedded" (log travels with DID document)
- No external resolution required

### 6.2 Layer 2: did:webvh

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://identity.foundation/didwebvh/v1"
  ],
  "id": "did:webvh:originals.example:assets:abc123",
  "controller": "did:webvh:originals.example:users:alice",
  "verificationMethod": [{
    "id": "did:webvh:originals.example:assets:abc123#key-1",
    "type": "Multikey",
    "controller": "did:webvh:originals.example:users:alice",
    "publicKeyMultibase": "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
  }],
  "authentication": ["#key-1"],
  "assertionMethod": ["#key-1"],
  "service": [{
    "id": "did:webvh:originals.example:assets:abc123#cel",
    "type": "CryptographicEventLog",
    "serviceEndpoint": "https://originals.example/.well-known/cel/assets/abc123.json"
  }],
  "alsoKnownAs": [
    "did:peer:2.Ez6LSbysY2MkESH3bDt1vrKKKzLYfRoQqpvVdBPPUCUtwFSv3"
  ]
}
```

**Notes:**
- Uses did:webvh (Web Verifiable History)
- `alsoKnownAs` links to previous did:peer identity
- Service endpoint is HTTPS URL to the CEL
- Resolution via `https://originals.example/.well-known/did/assets/abc123/did.json`

### 6.3 Layer 3: did:btco

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://github.com/nickkatsios/did-btco"
  ],
  "id": "did:btco:abc123def456...",
  "controller": "did:btco:abc123def456...",
  "verificationMethod": [{
    "id": "did:btco:abc123def456...#key-1",
    "type": "Multikey",
    "controller": "did:btco:abc123def456...",
    "publicKeyMultibase": "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
  }],
  "authentication": ["#key-1"],
  "assertionMethod": ["#key-1"],
  "service": [{
    "id": "did:btco:abc123def456...#cel",
    "type": "CryptographicEventLog",
    "serviceEndpoint": {
      "inscription": "abc123def456i0",
      "fallback": "https://ordinals.example/content/abc123def456i0"
    }
  }, {
    "id": "did:btco:abc123def456...#ordinal",
    "type": "BitcoinOrdinal",
    "serviceEndpoint": {
      "sat": 1923456789012345,
      "inscriptionId": "abc123def456i0"
    }
  }],
  "alsoKnownAs": [
    "did:webvh:originals.example:assets:abc123",
    "did:peer:2.Ez6LSbysY2MkESH3bDt1vrKKKzLYfRoQqpvVdBPPUCUtwFSv3"
  ]
}
```

**Notes:**
- DID derived from inscription ID or ordinal number
- `alsoKnownAs` creates complete identity chain
- Service endpoint includes inscription reference
- Resolution via ordinals indexer or direct node query

---

## 7. Serialization

### 7.1 JSON (Default)

The default serialization is JSON with the following conventions:

- **Media Type:** `application/cel+json`
- **File Extension:** `.cel.json` or `.cel`
- **Character Encoding:** UTF-8
- **Canonicalization:** JCS (RFC 8785) for hashing

### 7.2 CBOR (Compact)

For bandwidth-constrained environments:

- **Media Type:** `application/cel+cbor`
- **File Extension:** `.cel.cbor`
- **Compression:** ~50% size reduction vs JSON

**CBOR Tag Assignments:**

| Tag | Property |
|-----|----------|
| 20 | `log` |
| 21 | `event` |
| 22 | `operation` |
| 23 | `type` |
| 24 | `dataReference` |
| 25 | `previousEvent` |
| 26 | `proof` |

### 7.3 Size Limits

| Layer | Maximum Log Size | Chunking Threshold |
|-------|------------------|-------------------|
| Layer 1 | Unlimited | 10 MB recommended |
| Layer 2 | Server-defined | 10 MB |
| Layer 3 | ~390 KB (inscription limit) | N/A (use `previousLog`) |

---

## 8. Security Considerations

### 8.1 Threat Model

| Threat | Description | Mitigation |
|--------|-------------|------------|
| **History Forking** | Controller rewrites history | Witness diversity, fork detection |
| **Key Compromise** | Attacker steals controller key | Key rotation, recovery keys |
| **Replay Attack** | Old events replayed | Hash chain prevents insertion |
| **Content Substitution** | Different content for same hash | SHA-256 collision resistance |
| **Witness Collusion** | Witnesses conspire with attacker | Multiple independent witnesses |
| **Quantum Attack** | Future quantum computers break crypto | Post-quantum upgrade path |

### 8.2 Cryptographic Agility

The specification supports cryptosuite upgrade paths:

**Current (2026):**
- `eddsa-jcs-2022` - Ed25519 signatures
- `ecdsa-jcs-2019` - P-256/secp256k1 signatures

**Post-Quantum Ready:**
- `ml-dsa-jcs-2025` - ML-DSA (CRYSTALS-Dilithium)
- Transition: Add PQ witness signatures alongside classical

### 8.3 Privacy Considerations

| Concern | Recommendation |
|---------|----------------|
| Content privacy | Encrypt content, store hash only |
| Metadata privacy | Minimize PII in public logs |
| Transaction privacy | Layer 1 for sensitive creation |
| Correlation | Rotate keys between assets |

---

## 9. Implementation Notes

### 9.1 SDK Module Structure

```
packages/sdk/src/cel/
├── types.ts           # TypeScript interfaces
├── event-log.ts       # Log creation and manipulation
├── operations/
│   ├── create.ts      # Create operation
│   ├── update.ts      # Update operation
│   ├── migrate.ts     # Migration operation
│   └── deactivate.ts  # Deactivation operation
├── verification/
│   ├── hash-chain.ts  # Hash chain verification
│   ├── proofs.ts      # Proof verification
│   └── witnesses.ts   # Witness validation
├── serialization/
│   ├── json.ts        # JSON serialization
│   └── cbor.ts        # CBOR serialization
└── layers/
    ├── peer.ts        # did:peer layer
    ├── webvh.ts       # did:webvh layer
    └── btco.ts        # did:btco layer
```

### 9.2 TypeScript Interfaces

```typescript
interface CryptographicEventLog {
  log: LogEntry[];
  previousLog?: ExternalReference & { proof: DataIntegrityProof[] };
}

interface LogEntry {
  event: Event;
  proof: DataIntegrityProof[];
}

interface Event {
  operation: Operation;
  previousEvent?: string; // Multibase-encoded Multihash
}

interface Operation {
  type: 'create' | 'update' | 'migrate' | 'deactivate';
  data?: object;
  dataReference?: ExternalReference;
}

interface ExternalReference {
  url?: string[];
  mediaType?: string;
  digestMultibase: string;
}

interface MigrationData {
  fromDid: string;
  toDid: string;
  fromLayer: 1 | 2 | 3;
  toLayer: 2 | 3;
  reason: 'publish' | 'trade' | 'anchor' | 'backup';
  timestamp: string;
  didDocument?: object;
}
```

---

## 10. References

### Normative References

- [W3C CCG Cryptographic Event Log Specification](https://github.com/w3c-ccg/cel-spec)
- [W3C Decentralized Identifiers (DIDs) v1.0](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials Data Integrity 1.0](https://www.w3.org/TR/vc-data-integrity/)
- [did:peer Method Specification](https://identity.foundation/peer-did-method-spec/)
- [did:webvh Method Specification](https://identity.foundation/didwebvh/)
- [RFC 8785 - JSON Canonicalization Scheme (JCS)](https://tools.ietf.org/html/rfc8785)
- [Multiformats: Multibase](https://github.com/multiformats/multibase)
- [Multiformats: Multihash](https://github.com/multiformats/multihash)

### Informative References

- [Bitcoin Ordinals Protocol](https://docs.ordinals.com/)
- [ECDSA Cryptosuite v2019](https://www.w3.org/TR/vc-di-ecdsa/)
- [EdDSA Cryptosuite v2022](https://www.w3.org/TR/vc-di-eddsa/)

---

## Appendix A: Example Complete Event Log

```json
{
  "log": [
    {
      "event": {
        "operation": {
          "type": "create",
          "data": {
            "@context": ["https://www.w3.org/ns/credentials/v2", "https://originals.onion/ns/v1"],
            "type": ["Original"],
            "creator": "did:peer:2.Ez6LSbysY2MkESH3bDt1vrKKKzLYfRoQqpvVdBPPUCUtwFSv3",
            "created": "2026-01-15T10:00:00Z",
            "content": {
              "url": ["ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"],
              "mediaType": "image/png",
              "digestMultibase": "uEiC5TSe5k00TwGnPnRs25nAOGsSm4GIny2HW_Nml0ekzLA"
            },
            "metadata": {
              "name": "Sunset Over Mountains",
              "description": "Original photograph taken on January 15, 2026"
            },
            "proof": {
              "type": "DataIntegrityProof",
              "cryptosuite": "eddsa-jcs-2022",
              "created": "2026-01-15T10:00:00Z",
              "verificationMethod": "did:peer:2.Ez6LSbysY2MkESH3bDt1vrKKKzLYfRoQqpvVdBPPUCUtwFSv3#key-1",
              "proofPurpose": "assertionMethod",
              "proofValue": "z5vgFcMRgGUYt5NCSK8sX3N4hvhMqCZyJ1BXnU7GvJkDp3SJwQ6hP8KT"
            }
          }
        }
      },
      "proof": [{
        "type": "DataIntegrityProof",
        "cryptosuite": "eddsa-jcs-2022",
        "created": "2026-01-15T10:00:00Z",
        "verificationMethod": "did:peer:2.Ez6LSbysY2MkESH3bDt1vrKKKzLYfRoQqpvVdBPPUCUtwFSv3#key-1",
        "proofPurpose": "assertionMethod",
        "proofValue": "z5vgFcMRgGUYt5NCSK8sX3N4hvhMqCZyJ1BXnU7GvJkDp3SJwQ6hP8KT"
      }]
    },
    {
      "event": {
        "previousEvent": "uEiAkoYyQ6YVtUmER8pN24wLZcLK9EBguM5WZlbAgfXBDuQ",
        "operation": {
          "type": "migrate",
          "data": {
            "migration": {
              "fromDid": "did:peer:2.Ez6LSbysY2MkESH3bDt1vrKKKzLYfRoQqpvVdBPPUCUtwFSv3",
              "toDid": "did:webvh:originals.example:assets:sunset-001",
              "fromLayer": 1,
              "toLayer": 2,
              "reason": "publish",
              "timestamp": "2026-01-20T14:30:00Z"
            },
            "proof": {
              "type": "DataIntegrityProof",
              "cryptosuite": "eddsa-jcs-2022",
              "created": "2026-01-20T14:30:00Z",
              "verificationMethod": "did:peer:2.Ez6LSbysY2MkESH3bDt1vrKKKzLYfRoQqpvVdBPPUCUtwFSv3#key-1",
              "proofPurpose": "assertionMethod",
              "proofValue": "z4Kj8mN2pLqR7vXwY9zA3bC6dE5fG8hJ1kL4mN7oP0qR3sT6uV9wX2yZ"
            }
          }
        }
      },
      "proof": [{
        "type": "DataIntegrityProof",
        "cryptosuite": "eddsa-jcs-2022",
        "created": "2026-01-20T14:30:00Z",
        "verificationMethod": "did:peer:2.Ez6LSbysY2MkESH3bDt1vrKKKzLYfRoQqpvVdBPPUCUtwFSv3#key-1",
        "proofPurpose": "assertionMethod",
        "proofValue": "z4Kj8mN2pLqR7vXwY9zA3bC6dE5fG8hJ1kL4mN7oP0qR3sT6uV9wX2yZ"
      }, {
        "type": "DataIntegrityProof",
        "cryptosuite": "ecdsa-jcs-2019",
        "created": "2026-01-20T14:30:05Z",
        "verificationMethod": "https://originals.example/.well-known/did.json#witness-key",
        "proofPurpose": "assertionMethod",
        "proofValue": "zQxuF5obCSsrPrUMCtqY6JdqGDBtQLPFxpZxzwVWgHYrXxoV93gBHq"
      }]
    },
    {
      "event": {
        "previousEvent": "uEiBfhmMyElIQPrulFu-5ETYVLgzyvoPsmxTMpEds7iQPBw",
        "operation": {
          "type": "migrate",
          "data": {
            "migration": {
              "fromDid": "did:webvh:originals.example:assets:sunset-001",
              "toDid": "did:btco:abc123def456789012345678901234567890abcdef",
              "fromLayer": 2,
              "toLayer": 3,
              "reason": "anchor",
              "timestamp": "2026-01-30T09:00:00Z"
            },
            "inscription": {
              "id": "abc123def456789012345678901234567890abcdefi0",
              "txid": "abc123def456789012345678901234567890abcdef",
              "sat": 1923456789012345
            },
            "proof": {
              "type": "DataIntegrityProof",
              "cryptosuite": "eddsa-jcs-2022",
              "created": "2026-01-30T09:00:00Z",
              "verificationMethod": "did:webvh:originals.example:assets:sunset-001#key-1",
              "proofPurpose": "assertionMethod",
              "proofValue": "z9Xk3mN7oP0qR4sT8uV2wX5yZ1aB6cD9eF2gH5iJ8kL1mN4oP7qR0sT3uV"
            }
          }
        }
      },
      "proof": [{
        "type": "DataIntegrityProof",
        "cryptosuite": "eddsa-jcs-2022",
        "created": "2026-01-30T09:00:00Z",
        "verificationMethod": "did:webvh:originals.example:assets:sunset-001#key-1",
        "proofPurpose": "assertionMethod",
        "proofValue": "z9Xk3mN7oP0qR4sT8uV2wX5yZ1aB6cD9eF2gH5iJ8kL1mN4oP7qR0sT3uV"
      }, {
        "type": "BitcoinTimestampProof",
        "created": "2026-01-30T09:15:00Z",
        "verificationMethod": "btc:block:876543",
        "inscription": {
          "id": "abc123def456789012345678901234567890abcdefi0"
        }
      }]
    }
  ]
}
```

---

*This specification is an Application Specification building upon the W3C CCG Cryptographic Event Log specification. It defines the Originals-specific semantics for digital asset provenance across three infrastructure layers.*
