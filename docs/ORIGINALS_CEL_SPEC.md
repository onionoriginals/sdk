# Originals CEL Application Specification

**Version:** 1.2.0  
**Status:** Draft  
**Date:** 2026-07-11

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
| genesis (peer) | `did:cel` | Derived from the genesis event; self-certifying (see `specs/did-cel-method.md`) |
| webvh | `did:webvh` | HTTP-based with version history |
| btco  | `did:btco` | Bitcoin ordinals inscription |

Legacy logs use `did:peer` (numalgo 4) as the genesis identity; new logs derive a
`did:cel` from the genesis event.

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

The canonical form covers only the committed fields `{ type, data, previousEvent? }` —
never the `proof` array. Proofs carry the signature plus unsigned metadata, and
witness proofs may be appended after the fact; chaining over them would make the link
depend on data no signature commits to.

### 2.4 Authority Evolution

Authority over a log is **not** fixed for its lifetime. The initial authorized key is
established by the genesis `controller` (bound fail-closed; see
[`specs/did-cel-method.md`](../specs/did-cel-method.md) §3.1). Thereafter:

- A fully valid `rotateKey` event (§5.6) **REPLACES** the authorized key set with the
  new controller's keys. Replace, not union: retired keys are dead from that event
  forward, and verifiers MUST reject post-rotation events signed by them.
- A `rotateKey` MUST pass every check (chain, signature, current-set authorization,
  target bindability) BEFORE the swap; a failed rotation MUST NOT rotate.
- `migrate` events MUST NOT change the authorized key set. (Legacy `transfer` events —
  §5.5 — likewise never changed it; ownership is the sat, not a log event.)
- **Post-transfer append authority (rotation-first).** Ownership moves with the sat
  alone and writes nothing to the log (§5.5); this rule governs only *authoring*. A new
  sat holder who wants to append provenance gains authority only via their first act — a
  `rotateKey` (backed on-chain by a reinscription proving sat control). Old-key events
  timestamped after the sat move are rejected. Author-enablement is optional; a holder
  who never rotates is still the owner. See the design doc §5.

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

### 5.1 Create Event (Genesis)

Initializes a new asset and establishes controller authority. The genesis event is
the preimage of the asset's `did:cel` identifier (see
[`specs/did-cel-method.md`](../specs/did-cel-method.md)); the DID is **derived from**
this event and therefore MUST NOT be embedded in it.

#### 5.1.1 Structure (`CelAssetData` — current write shape)

```json
{
  "type": "create",
  "data": {
    "name": "My Digital Artwork",
    "controller": "did:key:z6Mk...",
    "resources": [
      {
        "digestMultibase": "uXYZ...",
        "mediaType": "image/png",
        "url": ["ipfs://Qm..."]
      }
    ],
    "createdAt": "2026-01-20T12:00:00Z",
    "nonce": "uAAAAAAAAAAAAAAAAAAAAAA"
  },
  "proof": [
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "created": "2026-01-20T12:00:00Z",
      "verificationMethod": "did:key:z6Mk...#z6Mk...",
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
| `controller` | string | Yes | The **holder's** key DID (`did:key`, or a resolvable DID) — distinct from the derived asset `did:cel` |
| `resources` | array | Yes | Associated external references (MAY be empty) |
| `createdAt` | string | Yes | ISO 8601 creation timestamp |
| `nonce` | string | Yes | Multibase base64url of 16 random bytes — collision insurance for the derived DID |

#### 5.1.3 Rules

- MUST be the first event in any log
- MUST NOT have a `previousEvent` field
- MUST NOT contain a `did` field — identity is derived, not embedded
- MUST carry exactly one controller proof (the unsigned proof array cannot
  disambiguate an injected co-signer)
- The genesis proof MUST bind to `controller`, fail-closed, with no
  trust-on-first-use (see `specs/did-cel-method.md` §3.1)
- `resources` array MAY be empty

#### 5.1.4 Legacy genesis shape (`PeerAssetData`) — read-only

Logs written by pre-`did:cel` releases embed the asset DID directly:

```json
{
  "name": "My Digital Artwork",
  "did": "did:peer:4zQm...",
  "layer": "peer",
  "resources": [ /* ... */ ],
  "creator": "did:peer:4zQm...",
  "createdAt": "2026-01-20T12:00:00Z"
}
```

- Readers MUST continue to accept this shape (dual-accept); the reported asset DID is
  the declared `data.did`.
- Writers MUST NOT emit it; new assets use `CelAssetData` above.
- Behavioral delta: a genesis whose `data.did` is a *malformed* long-form
  `did:peer:4` now fails closed — only when the genesis proof's `verificationMethod`
  is itself a `did:key` (previously trust-on-first-use).

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

### 5.4 Migrate Event

A first-class layer transition (previously folded into `update`). Records the asset
earning a stronger resolution substrate. Does **not** change authority.

#### 5.4.1 Structure

```json
{
  "type": "migrate",
  "data": {
    "sourceDid": "did:cel:uEiD...",
    "targetDid": "did:webvh:example.com:abc123",
    "layer": "webvh",
    "domain": "example.com",
    "migratedAt": "2026-01-23T12:00:00Z"
  },
  "previousEvent": "uGHI...",
  "proof": [ /* controller proof, + witness proof(s) as the target layer requires */ ]
}
```

#### 5.4.2 Data Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceDid` | string | Yes | The layer DID being migrated from |
| `targetDid` | string | Yes | The newly minted layer DID |
| `layer` | string | Yes | Target layer (`webvh` or `btco`) |
| `migratedAt` | string | Yes | ISO 8601 timestamp |
| `domain` | string | webvh | Hosting domain (webvh target) |
| `txid` / `inscriptionId` | string | btco | Bitcoin anchor fields (btco target) |

#### 5.4.3 Rules

- MUST include `previousEvent` hash
- MUST follow the one-way path `peer → webvh → btco` (see §6.2); reverse or
  layer-skipping migrations are invalid
- MUST NOT change the authorized key set — migration is not a key rotation
- The asset's `did:cel` identity is unchanged; `targetDid` records a new substrate,
  not a new identity

### 5.5 Transfer Event (LEGACY — read-only)

> **LEGACY as of 1.2.0.** Ownership **is** the Bitcoin sat/UTXO (btco layer): a transfer
> is a pure sat move that writes **nothing** to the CEL, and ownership is read live from
> sat control, not reconstructed from a log event. The `transfer` event type is retained
> only for backward compatibility: **verifiers MUST accept** a well-formed `transfer`
> event in pre-1.2.0 logs (dual-accept), but **writers MUST NOT emit** it. The structure
> and rules below describe those legacy events; they are informative for verifier
> conformance, not a supported write path.

Records a legacy ownership hand-off. Identity is unchanged and authority does **not**
change — a legacy `transfer` event never became a log signer for the recipient.

#### 5.5.1 Structure

```json
{
  "type": "transfer",
  "data": {
    "previousOwner": "bc1q...sender",
    "newOwner": "bc1q...recipient",
    "txid": "abc123...",
    "transferredAt": "2026-01-24T12:00:00Z"
  },
  "previousEvent": "uJKL...",
  "proof": [ /* controller proof (still the pre-transfer controller) */ ]
}
```

#### 5.5.2 Data Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transferredAt` | string | Yes | ISO 8601 timestamp |
| `txid` | string | SHOULD | Bitcoin transaction ID moving the sat |
| `previousOwner` / `newOwner` | string | No | Surfaced in derived state metadata |

#### 5.5.3 Rules

- MUST include `previousEvent` hash
- MUST NOT change the authorized key set — a `transfer` is not a `rotateKey`; the new
  owner's key does not become a log signer until they rotate

### 5.6 RotateKey Event

Hands authority from the current controller to a new controller. This is the sole
event type that changes the authorized key set.

#### 5.6.1 Structure

```json
{
  "type": "rotateKey",
  "data": {
    "newController": "did:key:z6MkNew...",
    "rotatedAt": "2026-01-25T12:00:00Z"
  },
  "previousEvent": "uMNO...",
  "proof": [ /* signed by the CURRENT (pre-rotation) controller */ ]
}
```

#### 5.6.2 Data Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `newController` | string | Yes | The new controller DID — MUST be self-certifying (`did:key` or long-form `did:peer:4`) |
| `rotatedAt` | string | Yes | ISO 8601 timestamp |

#### 5.6.3 Rules

- MUST include `previousEvent` hash
- MUST be signed by a key in the authorized set as it stood when appended
- MUST pass all checks BEFORE the set is swapped; a rotation that fails any check
  MUST NOT rotate
- `newController` MUST be self-certifying; a resolver-backed, missing, non-string, or
  unbindable `newController` MUST fail the event and the log
- REPLACES (not unions) the authorized key set — the retired keys are dead from this
  event forward (see §2.4)

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

Migrations are first-class `migrate` events (§5.4). Legacy logs may carry migrations
as `update` events with the same data fields (`sourceDid` + `targetDid` + `layer`);
readers MUST still recognize that legacy shape, but writers MUST emit `migrate`:

```json
{
  "type": "migrate",
  "data": {
    "sourceDid": "did:cel:uEiD...",
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

A first-class migration is identified by its event `type` of `migrate`. For legacy
logs that recorded migrations as `update` events, detection falls back to:

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
| 1.1.0 | 2026-07-10 | `did:cel` genesis (`CelAssetData`, `did`-embedded shape marked legacy read-only); first-class `migrate`/`transfer`/`rotateKey` event types; evolving-authority / rotation semantics (§2.4). See `specs/did-cel-method.md`. |
| 1.2.0 | 2026-07-11 | Ownership **is** the sat; the CEL is authorship only. `transfer` event (§5.5) demoted to **legacy/read-only** — verifiers MUST accept it in old logs, writers MUST NOT emit it; transfers are pure sat moves that write nothing to the CEL. Post-transfer authority rule (§2.4) rescoped to author-enablement only. |
