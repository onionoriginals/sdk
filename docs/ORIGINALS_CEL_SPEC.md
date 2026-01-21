# Originals CEL Application Specification

**Version:** 1.0.0  
**Status:** Draft  
**Date:** January 2026

## Abstract

This document specifies the **Originals CEL (Cryptographic Event Log)** application profile, which combines the W3C CCG Cryptographic Event Log specification with the Originals Protocol to provide verifiable provenance for digital assets. The specification defines how Originals assets record their lifecycle through cryptographically signed events, enabling trustless verification of authenticity, ownership, and history.

---

## 1. Introduction

### 1.1 Purpose

The Originals CEL specification defines a standardized format for recording the complete lifecycle of digital assets as a cryptographic event log. This enables:

- **Verifiable Provenance**: Every state change is cryptographically signed and hash-chained
- **Decentralized Trust**: No central authority required for verification
- **Progressive Trust Layers**: Assets can migrate through trust tiers (peer → webvh → btco)
- **Offline Verification**: Logs can be verified without network connectivity

### 1.2 Scope

This specification covers:

- Event log structure and types for Originals assets
- Cryptographic proof requirements per trust layer
- Witness attestation rules and formats
- State derivation algorithms
- Migration event semantics

### 1.3 Conformance

Implementations MUST support all event types defined in this specification. Implementations MAY support additional event types but MUST NOT alter the semantics of specified types.

### 1.4 Terminology

| Term | Definition |
|------|------------|
| **Event Log** | An ordered sequence of cryptographically linked events |
| **Log Entry** | A single event in the log with type, data, proof(s), and chain reference |
| **Controller** | The entity authorized to sign events (identified by DID) |
| **Witness** | A third party that attests to an event's existence at a point in time |
| **Layer** | A trust tier: `peer` (local), `webvh` (HTTP-witnessed), `btco` (Bitcoin-anchored) |

### 1.5 References

- [W3C CCG Cryptographic Event Log Specification](https://w3c-ccg.github.io/cel-spec/)
- [W3C Data Integrity 1.0](https://w3c.github.io/vc-data-integrity/)
- [DID Core Specification](https://www.w3.org/TR/did-core/)
- [Originals Protocol Whitepaper](../originals-whitepaper.md)

---

## 2. Cryptographic Control

### 2.1 DID-Based Authorization

Every Originals asset is controlled by a Decentralized Identifier (DID). The controller DID determines who is authorized to sign events for that asset.

#### 2.1.1 Controller DID Requirements

- Assets MUST have exactly one controller DID at any time
- The controller DID is established in the `create` event
- Controller authority is verified via the proof's `verificationMethod` field
- The `verificationMethod` MUST reference a public key in the controller's DID document

#### 2.1.2 DID Methods by Layer

| Layer | DID Method | Resolution |
|-------|------------|------------|
| peer  | `did:peer` | Self-contained (numalgo 4) |
| webvh | `did:webvh` | HTTP-based with version history |
| btco  | `did:btco` | Bitcoin ordinals inscription |

### 2.2 Proof Requirements

Every event MUST include at least one proof from the asset controller.

#### 2.2.1 DataIntegrityProof Structure

```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "eddsa-jcs-2022",
  "created": "2026-01-20T12:00:00Z",
  "verificationMethod": "did:peer:4zQm...#key-0",
  "proofPurpose": "assertionMethod",
  "proofValue": "z3FXQkcW..."
}
```

#### 2.2.2 Required Proof Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Must be `"DataIntegrityProof"` |
| `cryptosuite` | string | Yes | Cryptographic suite identifier |
| `created` | string | Yes | ISO 8601 timestamp |
| `verificationMethod` | string | Yes | DID URL of signing key |
| `proofPurpose` | string | Yes | Purpose (typically `"assertionMethod"`) |
| `proofValue` | string | Yes | Multibase-encoded signature |

#### 2.2.3 Supported Cryptosuites

| Cryptosuite | Key Type | Use Case |
|-------------|----------|----------|
| `eddsa-jcs-2022` | Ed25519 | Primary signing |
| `eddsa-rdfc-2022` | Ed25519 | RDF canonicalization |
| `bitcoin-ordinals-2024` | secp256k1 | Bitcoin witnessing |

### 2.3 Hash Chain Integrity

Events are cryptographically linked via the `previousEvent` field.

#### 2.3.1 Hash Computation

```
previousEvent = computeDigestMultibase(canonicalize(previousLogEntry))
```

Where:
- `canonicalize()` produces a deterministic JSON serialization (sorted keys)
- `computeDigestMultibase()` returns `u` + base64url-nopad(SHA-256(data))

#### 2.3.2 Chain Rules

1. The first event (`create`) MUST NOT have a `previousEvent` field
2. All subsequent events MUST include `previousEvent` referencing the prior event
3. The hash MUST match the SHA-256 digest of the previous event's canonical form

---

## 3. State Derivation

### 3.1 Algorithm

To derive the current state of an asset, replay all events in order:

```
function deriveCurrentState(log: EventLog): AssetState
  require log.events.length > 0
  require log.events[0].type == "create"
  
  state = extractInitialState(log.events[0])
  
  for i = 1 to log.events.length - 1:
    event = log.events[i]
    if event.type == "update":
      state = applyUpdate(state, event.data)
    else if event.type == "deactivate":
      state.deactivated = true
      state.deactivationReason = event.data.reason
  
  return state
```

### 3.2 AssetState Structure

```typescript
interface AssetState {
  did: string;                    // Current DID
  name?: string;                  // Asset name
  layer: 'peer' | 'webvh' | 'btco';  // Current trust layer
  resources: ExternalReference[]; // Associated resources
  creator?: string;               // Creator DID
  createdAt?: string;             // Creation timestamp
  updatedAt?: string;             // Last update timestamp
  deactivated: boolean;           // Deactivation status
  metadata?: Record<string, unknown>; // Additional metadata
}
```

### 3.3 Update Application Rules

When applying an update event:

1. **Known Fields**: Directly update `name`, `resources`, `did`, `layer`
2. **Migration Events**: If `targetDid` and `layer` present, update DID and layer
3. **Custom Fields**: Store in `metadata` object
4. **Timestamps**: Use `updatedAt` or `migratedAt` as appropriate

### 3.4 Deactivation Handling

When a `deactivate` event is encountered:

1. Set `deactivated = true`
2. Store `reason` in `metadata.deactivationReason`
3. Update `updatedAt` from `deactivatedAt`
4. No further updates are valid (implementation MUST reject)

---

## 4. Witness Rules

### 4.1 Overview

Witnesses provide independent attestation that an event existed at a specific time. Witness requirements vary by layer.

### 4.2 Witness Rules by Layer

| Layer | Witness Requirement | Witness Type |
|-------|---------------------|--------------|
| `peer` | None | N/A |
| `webvh` | Optional (0+) | HTTP Witness |
| `btco` | Required (1) | Bitcoin Witness |

### 4.3 WitnessProof Structure

A WitnessProof extends DataIntegrityProof with additional fields:

```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "eddsa-jcs-2022",
  "created": "2026-01-20T12:00:00Z",
  "verificationMethod": "did:web:witness.example.com#key-0",
  "proofPurpose": "assertionMethod",
  "proofValue": "z4FXQK...",
  "witnessedAt": "2026-01-20T12:00:01Z"
}
```

The `witnessedAt` field distinguishes witness proofs from controller proofs.

### 4.4 HTTP Witness (webvh Layer)

#### 4.4.1 Witness Request

```http
POST /api/witness HTTP/1.1
Host: witness.example.com
Content-Type: application/json

{
  "digestMultibase": "uXYZ..."
}
```

#### 4.4.2 Witness Response

```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "eddsa-jcs-2022",
  "created": "2026-01-20T12:00:00Z",
  "verificationMethod": "did:web:witness.example.com#key-0",
  "proofPurpose": "assertionMethod",
  "proofValue": "z4FXQK...",
  "witnessedAt": "2026-01-20T12:00:01Z"
}
```

### 4.5 Bitcoin Witness (btco Layer)

#### 4.5.1 BitcoinWitnessProof Structure

```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "bitcoin-ordinals-2024",
  "created": "2026-01-20T12:00:00Z",
  "verificationMethod": "did:btco:abc123#key-0",
  "proofPurpose": "assertionMethod",
  "proofValue": "z4FXQK...",
  "witnessedAt": "2026-01-20T12:00:01Z",
  "txid": "abc123...",
  "blockHeight": 880000,
  "satoshi": 1234567890,
  "inscriptionId": "abc123i0"
}
```

#### 4.5.2 Attestation Data Inscribed

```json
{
  "@context": "https://w3id.org/security/v2",
  "type": "WitnessAttestation",
  "digestMultibase": "uXYZ...",
  "witnessedAt": "2026-01-20T12:00:01Z"
}
```

### 4.6 Proof Ordering

Within an event's `proof` array:

1. **Controller proof(s)** MUST appear first
2. **Witness proof(s)** MUST appear after controller proofs
3. Multiple witness proofs are appended in order of attestation

---

## 5. Event Types

### 5.1 Create Event

Initializes a new asset and establishes controller authority.

#### 5.1.1 Structure

```json
{
  "type": "create",
  "data": {
    "name": "My Digital Artwork",
    "did": "did:peer:4zQm...",
    "layer": "peer",
    "resources": [
      {
        "digestMultibase": "uXYZ...",
        "mediaType": "image/png",
        "url": ["ipfs://Qm..."]
      }
    ],
    "creator": "did:peer:4zQm...",
    "createdAt": "2026-01-20T12:00:00Z"
  },
  "proof": [
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "created": "2026-01-20T12:00:00Z",
      "verificationMethod": "did:peer:4zQm...#key-0",
      "proofPurpose": "assertionMethod",
      "proofValue": "z3FXQ..."
    }
  ]
}
```

#### 5.1.2 Required Data Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable asset name |
| `did` | string | Yes | Asset DID |
| `layer` | string | Yes | Initial layer (`peer`) |
| `resources` | array | Yes | Associated external resources |
| `creator` | string | Yes | Creator DID |
| `createdAt` | string | Yes | ISO 8601 creation timestamp |

#### 5.1.3 Rules

- MUST be the first event in any log
- MUST NOT have a `previousEvent` field
- `creator` equals `did` at peer layer (self-issued)
- `resources` array MAY be empty

### 5.2 Update Event

Modifies asset state (metadata, resources, or custom fields).

#### 5.2.1 Structure

```json
{
  "type": "update",
  "data": {
    "name": "Updated Artwork Title",
    "description": "A detailed description",
    "updatedAt": "2026-01-21T12:00:00Z"
  },
  "previousEvent": "uABC...",
  "proof": [
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "created": "2026-01-21T12:00:00Z",
      "verificationMethod": "did:peer:4zQm...#key-0",
      "proofPurpose": "assertionMethod",
      "proofValue": "z4XYZ..."
    }
  ]
}
```

#### 5.2.2 Rules

- MUST include `previousEvent` hash
- Data is merged with current state (partial updates allowed)
- SHOULD include `updatedAt` timestamp
- MUST NOT be applied to deactivated logs

### 5.3 Deactivate Event

Permanently seals the event log, preventing further modifications.

#### 5.3.1 Structure

```json
{
  "type": "deactivate",
  "data": {
    "reason": "Asset transferred to new owner",
    "deactivatedAt": "2026-01-22T12:00:00Z"
  },
  "previousEvent": "uDEF...",
  "proof": [
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "created": "2026-01-22T12:00:00Z",
      "verificationMethod": "did:peer:4zQm...#key-0",
      "proofPurpose": "assertionMethod",
      "proofValue": "z5ABC..."
    }
  ]
}
```

#### 5.3.2 Required Data Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reason` | string | Yes | Human-readable deactivation reason |
| `deactivatedAt` | string | Yes | ISO 8601 deactivation timestamp |

#### 5.3.3 Rules

- MUST include `previousEvent` hash
- MUST be the final event in the log
- Implementations MUST reject updates after deactivation
- Double-deactivation is an error

---

## 6. Migration Events

### 6.1 Overview

Migration events transition an asset from one trust layer to another, updating the asset DID and optionally adding witness attestations.

### 6.2 Valid Migration Paths

```
peer → webvh → btco
```

- Migration is **one-way and irreversible**
- Skipping layers is NOT allowed (e.g., peer → btco directly)
- Reverse migration is NOT allowed (e.g., btco → webvh)

### 6.3 Migration Event Structure

Migration events are `update` type events with specific data fields:

```json
{
  "type": "update",
  "data": {
    "sourceDid": "did:peer:4zQm...",
    "targetDid": "did:webvh:example.com:abc123",
    "layer": "webvh",
    "domain": "example.com",
    "migratedAt": "2026-01-23T12:00:00Z"
  },
  "previousEvent": "uGHI...",
  "proof": [
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "created": "2026-01-23T12:00:00Z",
      "verificationMethod": "did:webvh:example.com:abc123#key-0",
      "proofPurpose": "assertionMethod",
      "proofValue": "z6DEF..."
    },
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "witnessedAt": "2026-01-23T12:00:01Z",
      "verificationMethod": "did:web:witness.example.com#key-0",
      "proofPurpose": "assertionMethod",
      "proofValue": "z7GHI..."
    }
  ]
}
```

### 6.4 peer → webvh Migration

#### 6.4.1 Required Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceDid` | string | Yes | Original did:peer |
| `targetDid` | string | Yes | New did:webvh |
| `layer` | string | Yes | Must be `"webvh"` |
| `domain` | string | Yes | Domain hosting the DID |
| `migratedAt` | string | Yes | ISO 8601 timestamp |

#### 6.4.2 DID Generation

```
did:webvh:{domain}:{identifier}
```

Where `{identifier}` is derived from the source peer DID for linkage.

### 6.5 webvh → btco Migration

#### 6.5.1 Required Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceDid` | string | Yes | Original did:webvh |
| `targetDid` | string | Yes | New did:btco |
| `layer` | string | Yes | Must be `"btco"` |
| `txid` | string | Yes | Bitcoin transaction ID |
| `inscriptionId` | string | Yes | Ordinals inscription ID |
| `migratedAt` | string | Yes | ISO 8601 timestamp |

#### 6.5.2 DID Generation

```
did:btco:{inscriptionId}
```

The DID is derived from the Bitcoin ordinals inscription ID.

#### 6.5.3 Bitcoin Witness Requirement

- Migration to btco MUST include a Bitcoin witness proof
- The witness inscribes the migration event attestation on-chain
- The `txid`, `blockHeight`, `satoshi`, and `inscriptionId` are recorded

### 6.6 Detecting Migration Events

Migration events are distinguished from regular updates by:

1. Presence of both `sourceDid` and `targetDid` fields
2. A `layer` field indicating the target layer
3. Optional layer-specific fields (`domain`, `txid`, `inscriptionId`)

---

## 7. External References

### 7.1 Structure

Large resources are referenced rather than embedded:

```json
{
  "digestMultibase": "uXYZ...",
  "mediaType": "image/png",
  "url": ["ipfs://Qm...", "https://cdn.example.com/image.png"]
}
```

### 7.2 Required Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `digestMultibase` | string | Yes | Content hash (SHA-256, base64url-nopad) |
| `mediaType` | string | No | MIME type |
| `url` | string[] | No | Retrieval URLs |

### 7.3 Hash Verification

To verify external reference integrity:

```
verifyExternalReference(ref, content):
  expectedHash = computeDigestMultibase(content)
  return ref.digestMultibase == expectedHash
```

---

## 8. Serialization

### 8.1 JSON Serialization

- Use 2-space indentation for human readability
- Sort object keys alphabetically for deterministic output
- Timestamps in ISO 8601 format with timezone

### 8.2 CBOR Serialization

- Use CBOR for bandwidth-sensitive applications
- CBOR output is typically 20-40% smaller than JSON
- Round-trip between JSON and CBOR MUST preserve all data

---

## 9. Verification

### 9.1 Verification Algorithm

```
function verifyEventLog(log: EventLog): VerificationResult
  errors = []
  eventResults = []
  
  for i = 0 to log.events.length - 1:
    event = log.events[i]
    
    // Verify proofs
    proofValid = verifyProofs(event)
    
    // Verify chain
    if i == 0:
      chainValid = (event.previousEvent == undefined)
    else:
      expectedHash = computeDigestMultibase(log.events[i-1])
      chainValid = (event.previousEvent == expectedHash)
    
    eventResults.push({
      index: i,
      type: event.type,
      proofValid: proofValid,
      chainValid: chainValid,
      errors: [...event errors...]
    })
  
  return {
    verified: all events valid,
    errors: errors,
    events: eventResults
  }
```

### 9.2 Verification Result

```typescript
interface VerificationResult {
  verified: boolean;
  errors: string[];
  events: EventVerification[];
}

interface EventVerification {
  index: number;
  type: EventType;
  proofValid: boolean;
  chainValid: boolean;
  errors: string[];
}
```

---

## Appendix A: Complete Event Log Example

```json
{
  "events": [
    {
      "type": "create",
      "data": {
        "name": "Genesis Artwork #1",
        "did": "did:peer:4zQmR...",
        "layer": "peer",
        "resources": [
          {
            "digestMultibase": "uQvPc...",
            "mediaType": "image/png",
            "url": ["ipfs://QmABC..."]
          }
        ],
        "creator": "did:peer:4zQmR...",
        "createdAt": "2026-01-20T10:00:00Z"
      },
      "proof": [{
        "type": "DataIntegrityProof",
        "cryptosuite": "eddsa-jcs-2022",
        "created": "2026-01-20T10:00:00Z",
        "verificationMethod": "did:peer:4zQmR...#key-0",
        "proofPurpose": "assertionMethod",
        "proofValue": "z3FXQkcWb..."
      }]
    },
    {
      "type": "update",
      "data": {
        "description": "A beautiful digital artwork",
        "updatedAt": "2026-01-20T11:00:00Z"
      },
      "previousEvent": "uH4sI...",
      "proof": [{
        "type": "DataIntegrityProof",
        "cryptosuite": "eddsa-jcs-2022",
        "created": "2026-01-20T11:00:00Z",
        "verificationMethod": "did:peer:4zQmR...#key-0",
        "proofPurpose": "assertionMethod",
        "proofValue": "z4YQw..."
      }]
    },
    {
      "type": "update",
      "data": {
        "sourceDid": "did:peer:4zQmR...",
        "targetDid": "did:webvh:example.com:abc123",
        "layer": "webvh",
        "domain": "example.com",
        "migratedAt": "2026-01-21T10:00:00Z"
      },
      "previousEvent": "uK7tP...",
      "proof": [
        {
          "type": "DataIntegrityProof",
          "cryptosuite": "eddsa-jcs-2022",
          "created": "2026-01-21T10:00:00Z",
          "verificationMethod": "did:webvh:example.com:abc123#key-0",
          "proofPurpose": "assertionMethod",
          "proofValue": "z5XRt..."
        },
        {
          "type": "DataIntegrityProof",
          "cryptosuite": "eddsa-jcs-2022",
          "created": "2026-01-21T10:00:01Z",
          "verificationMethod": "did:web:witness.example.com#key-0",
          "proofPurpose": "assertionMethod",
          "proofValue": "z6WPq...",
          "witnessedAt": "2026-01-21T10:00:01Z"
        }
      ]
    }
  ]
}
```

---

## Appendix B: Error Codes

| Code | Description |
|------|-------------|
| `E001` | Empty event log |
| `E002` | First event is not a create event |
| `E003` | First event has previousEvent (invalid) |
| `E004` | Missing previousEvent in non-first event |
| `E005` | Hash chain broken |
| `E006` | Invalid proof structure |
| `E007` | Proof verification failed |
| `E008` | Update attempted on deactivated log |
| `E009` | Invalid migration path |
| `E010` | Missing required witness (btco layer) |

---

## Appendix C: Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01 | Initial release |
