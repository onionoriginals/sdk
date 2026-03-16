# Originals Protocol Specification

**Version:** 1.0.0
**Status:** Draft
**Date:** March 2026
**SDK Compatibility:** @originals/sdk v1.9.0+

---

## Abstract

The Originals Protocol defines a system for creating, discovering, and transferring digital assets with cryptographically verifiable provenance. Assets progress through three trust layers -- `did:peer`, `did:webvh`, and `did:btco` -- each offering increasing levels of discoverability, permanence, and security. This specification describes the data model, lifecycle rules, cryptographic requirements, and network architecture that implementations MUST follow.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Trust Layers](#2-trust-layers)
3. [Asset Model](#3-asset-model)
4. [Asset Lifecycle](#4-asset-lifecycle)
5. [Canonical Event Log (CEL)](#5-canonical-event-log-cel)
6. [Cryptographic Proofs](#6-cryptographic-proofs)
7. [Witness System](#7-witness-system)
8. [Resource Management](#8-resource-management)
9. [Asset Kinds](#9-asset-kinds)
10. [Verifiable Credentials](#10-verifiable-credentials)
11. [Bitcoin Integration](#11-bitcoin-integration)
12. [Network Deployments](#12-network-deployments)
13. [Key Management](#13-key-management)
14. [Security Considerations](#14-security-considerations)
15. [Conformance](#15-conformance)
16. [References](#16-references)

---

## 1. Introduction

### 1.1 Purpose

The Originals Protocol solves a fundamental problem: how to establish authentic provenance for digital assets without relying on a single trusted authority. It does this by combining Decentralized Identifiers (DIDs), Verifiable Credentials, and cryptographic event logs into a layered system where trust is added incrementally -- and only when the asset's value justifies the cost.

### 1.2 Design Principles

1. **Progressive trust.** Start free and private; add public discoverability and Bitcoin permanence only when needed.
2. **Cryptographic verifiability.** Every state change is signed and hash-chained. Verification requires no trusted third party.
3. **Content addressing.** Resources are identified by their SHA-256 hash, not by location.
4. **Unidirectional migration.** Assets move forward through trust layers and never backward, preserving the integrity of prior commitments.
5. **Standards alignment.** The protocol builds on W3C DID Core, W3C Verifiable Credentials, W3C CCG Cryptographic Event Logs, and Bitcoin Ordinals.

### 1.3 Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

| Term | Definition |
|------|-----------|
| **Asset** | A digital artifact with a DID, resources, an event log, and lifecycle state. |
| **Controller** | The entity authorized to sign events for an asset, identified by a DID. |
| **Event Log** | An ordered, hash-chained sequence of signed events recording an asset's history. See [Section 5](#5-canonical-event-log-cel). |
| **Layer** | One of three trust tiers: `peer`, `webvh`, or `btco`. |
| **Migration** | The act of moving an asset from one layer to the next. |
| **Resource** | A content-addressed file or data blob attached to an asset. |
| **Witness** | A third party that attests to an event at a point in time. |
| **Kind** | A typed classification for an asset (e.g., `originals:kind:app`). |

### 1.4 Notational Conventions

- JSON examples use relaxed formatting for readability. Implementations MUST produce valid JSON.
- DID URLs follow the syntax defined in [DID Core](https://www.w3.org/TR/did-core/).
- Hash values use multibase encoding with the `u` (base64url-no-pad) prefix unless otherwise noted.
- Timestamps use [RFC 3339](https://datatracker.ietf.org/doc/html/rfc3339) format (e.g., `2026-01-20T12:00:00Z`).

---

## 2. Trust Layers

The Originals Protocol defines three trust layers. Each layer maps to a DID method, a resolution mechanism, and a set of witness requirements. Assets MUST begin in the `peer` layer and MAY migrate forward through `webvh` and `btco`. Reverse migration is prohibited.

### 2.1 Layer 1: `did:peer` (Private Creation)

**DID method:** `did:peer` (numalgo 4)
**Resolution:** Self-contained -- the DID document is encoded within the identifier itself.
**Cost:** Free.
**Witnesses:** None required.
**Transferable:** No.

The `peer` layer is for private creation and experimentation. The creator is the sole controller. No network connectivity is required. This layer supports offline verification because the DID document is embedded in the identifier.

An asset in the `peer` layer is invisible to anyone who does not possess the DID.

### 2.2 Layer 2: `did:webvh` (Public Discovery)

**DID method:** `did:webvh`
**Format:** `did:webvh:{domain}:{scid}`
**Resolution:** HTTPS GET to `/.well-known/did.jsonl` on the specified domain.
**Cost:** ~$25/year (domain hosting).
**Witnesses:** Zero or more HTTP witnesses (OPTIONAL).
**Transferable:** No (but portable across domains via DID parameters).

The `webvh` layer makes assets publicly discoverable. The DID document is hosted as a JSONL version-history log, enabling third parties to resolve the identifier and verify its full history.

The `scid` (Self-Certifying Identifier) in the DID is derived from the source `did:peer` suffix, maintaining cryptographic linkage to the asset's origin.

Key rotation, metadata updates, and witness attestations are recorded as new entries in the version-history log.

### 2.3 Layer 3: `did:btco` (Permanent Ownership)

**DID method:** `did:btco`
**Format:** `did:btco:{satoshi}` (mainnet), `did:btco:sig:{satoshi}` (signet), `did:btco:reg:{satoshi}` (regtest)
**Resolution:** Query Bitcoin blockchain via Ordinals indexer.
**Cost:** $75-200 (Bitcoin transaction fees).
**Witnesses:** Exactly one Bitcoin witness (REQUIRED).
**Transferable:** Yes.

The `btco` layer anchors assets permanently on Bitcoin. The DID document is inscribed as an Ordinal on a specific satoshi. Ownership is determined by whoever controls the UTXO containing that satoshi.

This is the only layer where assets are transferable. Transfer creates a new Bitcoin transaction moving the inscribed satoshi to a new address, and updates the DID document accordingly.

### 2.4 Layer Comparison

| Property | peer | webvh | btco |
|----------|------|-------|------|
| Privacy | High (invisible) | Medium (public) | Low (public blockchain) |
| Cost | Free | ~$25/year | $75-200 one-time |
| Witnesses required | 0 | 0+ | 1 (Bitcoin) |
| Transferable | No | No | Yes |
| Key rotation | Local | Via version-history log | Via new inscription |
| Resolution | Self-contained | HTTPS | Bitcoin indexer |
| Offline verification | Yes | Yes (with cached log) | Yes (with cached chain) |

### 2.5 Migration Rules

1. Assets MUST begin in the `peer` layer.
2. Migration is strictly forward: `peer` -> `webvh` -> `btco`.
3. Implementations MUST NOT allow skipping layers (e.g., `peer` -> `btco` directly).
4. Implementations MUST NOT allow reverse migration.
5. Each migration creates a `migrate` event in the Canonical Event Log.
6. The source DID and target DID MUST both appear in the migration event for provenance continuity.

---

## 3. Asset Model

### 3.1 Asset Structure

An Originals asset consists of:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `did` | string | Yes | The asset's current DID. Changes on migration. |
| `name` | string | Yes | Human-readable asset name. |
| `layer` | `"peer"` \| `"webvh"` \| `"btco"` | Yes | Current trust layer. |
| `resources` | `AssetResource[]` | Yes | Content-addressed resources attached to the asset. |
| `eventLog` | `EventLog` | Yes | Canonical Event Log recording the asset's history. |
| `credentials` | `VerifiableCredential[]` | No | Credentials issued about or by this asset. |
| `kind` | string | No | Asset type classification. See [Section 9](#9-asset-kinds). |
| `manifest` | object | No | Kind-specific metadata. Structure depends on `kind`. |
| `createdAt` | string (RFC 3339) | Yes | Timestamp of creation. |
| `updatedAt` | string (RFC 3339) | Yes | Timestamp of last modification. |
| `deactivatedAt` | string (RFC 3339) | No | Timestamp of deactivation, if deactivated. |

### 3.2 Asset Identity

An asset's identity is its DID. When an asset migrates between layers, its DID changes (e.g., from `did:peer:4zQm...` to `did:webvh:magby.originals.build:abc123`). The migration event in the CEL provides the cryptographic proof that the new DID represents the same asset.

Implementations MUST maintain a continuous chain of migration events linking all DIDs that have represented a given asset.

### 3.3 Asset State

An asset is in exactly one of the following states at any time:

- **Active**: The asset accepts events (create, update, migrate).
- **Deactivated**: The asset is sealed. No further events are accepted.

There is no "draft" vs "published" distinction at the protocol level. The trust layer (`peer`, `webvh`, `btco`) determines discoverability, not a separate status flag.

---

## 4. Asset Lifecycle

### 4.1 Lifecycle Overview

```
CREATE (did:peer)
    |
    v
ACTIVE on peer  <---> UPDATE (metadata, resources)
    |
    | migrate
    v
ACTIVE on webvh <---> UPDATE (metadata, resources)
    |
    | migrate
    v
ACTIVE on btco  <---> UPDATE (metadata, resources)
    |                        |
    | deactivate             | transfer
    v                        v
DEACTIVATED           ACTIVE on btco (new owner)
```

### 4.2 Create

Creating an asset produces a `did:peer` identifier and an initial `create` event in the CEL.

**Preconditions:**
- None. Any entity can create an asset.

**Postconditions:**
- Asset exists in the `peer` layer.
- CEL contains exactly one event (the `create` event).
- The creator's DID is the asset's controller.

### 4.3 Update

Updating an asset modifies its metadata or resources without changing its layer.

**Preconditions:**
- Asset is active (not deactivated).
- Signer is the current controller.

**Postconditions:**
- A new `update` event is appended to the CEL.
- The event includes the SHA-256 hash of the previous event (`previousEvent` field).

### 4.4 Migrate

Migration moves an asset from its current layer to the next layer.

**Preconditions:**
- Asset is active.
- Current layer allows forward migration (peer -> webvh, webvh -> btco).
- Signer is the current controller.
- Witness requirements for the target layer are met.

**Postconditions:**
- Asset's `did` field changes to the new layer's DID.
- Asset's `layer` field updates to the target layer.
- A `migrate` event is appended to the CEL containing both `sourceDid` and `targetDid`.
- The migrate event includes the required witness proofs.

#### 4.4.1 Peer to WebVH Migration

- A `did:webvh` document is created on the configured domain.
- The `scid` in the new DID is derived from the `did:peer` suffix.
- HTTP witness proofs are OPTIONAL.

#### 4.4.2 WebVH to BTCO Migration

- The DID document is inscribed on Bitcoin as an Ordinal.
- Exactly one Bitcoin witness proof is REQUIRED.
- The inscription assigns the asset to a specific satoshi.

### 4.5 Transfer

Transfer changes the owner of a `did:btco` asset by moving the inscribed satoshi to a new Bitcoin address.

**Preconditions:**
- Asset is in the `btco` layer.
- Asset is active.
- Signer controls the UTXO containing the asset's satoshi.

**Postconditions:**
- A Bitcoin transaction moves the satoshi to the new owner's address.
- The DID document is updated to reflect the new controller.
- A `transfer` event is appended to the CEL.

### 4.6 Deactivate

Deactivation permanently seals an asset. No further events can be appended.

**Preconditions:**
- Asset is active.
- Signer is the current controller.

**Postconditions:**
- A `deactivate` event is appended to the CEL.
- `deactivatedAt` is set.
- Implementations MUST reject any subsequent events for this asset.

---

## 5. Canonical Event Log (CEL)

The Canonical Event Log is the authoritative record of an asset's history. It is an application profile of the [W3C CCG Cryptographic Event Log specification](https://w3c-ccg.github.io/cel-spec/).

### 5.1 Log Structure

```json
{
  "events": [LogEntry, LogEntry, ...],
  "previousLog": "optional-link-to-archived-chunk"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `events` | `LogEntry[]` | Yes | Ordered array of log entries. |
| `previousLog` | string | No | URI pointing to an archived log segment, enabling log chunking. |

### 5.2 Log Entry Structure

```json
{
  "type": "create",
  "data": { ... },
  "previousEvent": "uSHA256_HASH_OF_PRIOR_ENTRY",
  "proof": [DataIntegrityProof, ...]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Event type: `"create"`, `"update"`, or `"deactivate"`. |
| `data` | object | Yes | Event payload. Structure varies by type. |
| `previousEvent` | string | Conditional | SHA-256 hash of the prior entry. REQUIRED for all events except the first `create`. |
| `proof` | `DataIntegrityProof[]` | Yes | One or more cryptographic proofs. See [Section 6](#6-cryptographic-proofs). |

### 5.3 Event Types

#### 5.3.1 Create Event

The first event in every log. Establishes the asset's identity and initial state.

```json
{
  "type": "create",
  "data": {
    "name": "My Digital Artwork",
    "did": "did:peer:4zQmR8...",
    "layer": "peer",
    "resources": [
      {
        "digestMultibase": "uSHA256...",
        "mediaType": "image/png",
        "url": ["ipfs://Qm..."]
      }
    ],
    "kind": "originals:kind:media",
    "createdAt": "2026-01-20T12:00:00Z"
  },
  "proof": [{ ... }]
}
```

**Rules:**
- MUST be the first event in the log.
- MUST NOT include a `previousEvent` field.
- `data.layer` MUST be `"peer"`.
- `data.did` MUST be a valid `did:peer` identifier.
- MUST include exactly one controller proof.

#### 5.3.2 Update Event

Modifies the asset's metadata or resources.

```json
{
  "type": "update",
  "data": {
    "name": "My Digital Artwork (Revised)",
    "resources": [...],
    "updatedAt": "2026-02-01T10:00:00Z"
  },
  "previousEvent": "uSHA256...",
  "proof": [{ ... }]
}
```

**Rules:**
- MUST include `previousEvent`.
- `data` contains only the fields being updated (partial update).
- MUST include at least one controller proof.
- MAY include witness proofs after the controller proof.

#### 5.3.3 Migrate Event

A specialized update that changes the asset's layer. Represented as an `update` event with migration-specific fields.

```json
{
  "type": "update",
  "data": {
    "sourceDid": "did:peer:4zQmR8...",
    "targetDid": "did:webvh:magby.originals.build:abc123",
    "layer": "webvh",
    "domain": "magby.originals.build",
    "updatedAt": "2026-02-15T08:00:00Z"
  },
  "previousEvent": "uSHA256...",
  "proof": [
    { "controller proof from new DID" },
    { "witness proof (if required)" }
  ]
}
```

**Rules:**
- MUST include both `sourceDid` and `targetDid`.
- MUST include `layer` set to the target layer.
- `targetDid` MUST use the DID method corresponding to the target layer.
- Controller proof MUST reference a verification method in the `targetDid` document.
- For `btco` migrations, MUST include a Bitcoin witness proof.
- For `webvh` migrations, MAY include HTTP witness proofs.

**Layer-specific data fields:**

| Target Layer | Additional Fields |
|-------------|------------------|
| `webvh` | `domain` (the hosting domain) |
| `btco` | `txid`, `inscriptionId`, `satoshi`, `blockHeight` |

#### 5.3.4 Deactivate Event

Permanently seals the log.

```json
{
  "type": "deactivate",
  "data": {
    "reason": "Asset superseded by new version",
    "deactivatedAt": "2026-06-01T00:00:00Z"
  },
  "previousEvent": "uSHA256...",
  "proof": [{ ... }]
}
```

**Rules:**
- MUST be the final event in the log.
- Implementations MUST reject any events after a deactivate.
- MUST include `data.reason` (human-readable explanation).
- MUST include `data.deactivatedAt` timestamp.

### 5.4 Hash Chain

Events are cryptographically linked via SHA-256 hashes.

**Algorithm for computing `previousEvent`:**

1. Take the complete prior log entry (including `type`, `data`, `previousEvent`, and `proof`).
2. Canonicalize using sorted JSON keys (JSON Canonicalization Scheme per [RFC 8785](https://datatracker.ietf.org/doc/html/rfc8785)).
3. Compute SHA-256 hash of the canonical form.
4. Encode as multibase: `u` prefix + base64url-no-pad encoding.

```
previousEvent = "u" + base64url(SHA-256(JCS(previous_entry)))
```

This chain ensures:
- Events cannot be reordered.
- Events cannot be removed without breaking the chain.
- Tampering with any event invalidates all subsequent events.

### 5.5 State Derivation

To determine an asset's current state from its log:

1. Verify the first event is a `create` event with no `previousEvent`.
2. Initialize state from the `create` event's data.
3. For each subsequent event, in order:
   a. Verify the `previousEvent` hash matches the prior entry.
   b. Verify all proofs.
   c. Apply `data` fields as a partial update to the current state.
   d. If the event is a `deactivate`, mark the asset as deactivated and stop.
4. The resulting state is the asset's current state.

Implementations MUST reject logs where hash chain verification fails at any point.

---

## 6. Cryptographic Proofs

### 6.1 Data Integrity Proof

All proofs in the Originals Protocol use the [W3C Data Integrity](https://w3c.github.io/vc-data-integrity/) format.

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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | MUST be `"DataIntegrityProof"`. |
| `cryptosuite` | string | Yes | Identifier for the cryptographic suite. |
| `created` | string | Yes | RFC 3339 timestamp of proof creation. |
| `verificationMethod` | string | Yes | DID URL referencing the signer's public key. |
| `proofPurpose` | string | Yes | Purpose of the proof. Typically `"assertionMethod"`. |
| `proofValue` | string | Yes | Multibase-encoded signature. |

### 6.2 Supported Cryptosuites

| Cryptosuite | Curve | Key Format | Use Cases |
|-------------|-------|------------|-----------|
| `eddsa-jcs-2022` | Ed25519 | Multikey (`z6Mk...`) | Credential signing, CEL proofs, DID operations |
| `bitcoin-ordinals-2024` | secp256k1 | Multikey (`zQ3c...`) | Bitcoin witness attestations |

Implementations MUST support `eddsa-jcs-2022`. Implementations that support Bitcoin operations MUST also support `bitcoin-ordinals-2024`.

### 6.3 Key Encoding

All public and private keys MUST use Multikey encoding (multibase + multicodec). JSON Web Key (JWK) format MUST NOT be used.

**Multikey format:** `z` + base58btc(multicodec_prefix + raw_key_bytes)

| Key Type | Multicodec Prefix | Example Prefix |
|----------|-------------------|----------------|
| Ed25519 public | `0xed01` | `z6Mk...` |
| Ed25519 private | `0x8026` | `z3u2...` |
| secp256k1 public | `0xe701` | `zQ3c...` |
| secp256k1 private | `0x1301` | `z42t...` |
| P-256 public | `0x1200` | `zDn...` |
| P-256 private | `0x8626` | `z42...` |

### 6.4 Proof Ordering

Within a single event's `proof` array:

1. The controller proof MUST be first.
2. Witness proofs MUST follow the controller proof.
3. When multiple witnesses exist, they SHOULD appear in chronological order of attestation.

### 6.5 Proof Verification

To verify a Data Integrity Proof:

1. Resolve the `verificationMethod` DID URL to obtain the public key.
2. Verify the DID document lists this key for the declared `proofPurpose`.
3. Reconstruct the signed payload (document + proof options, minus `proofValue`).
4. Canonicalize the payload using the cryptosuite's canonicalization algorithm (JCS for `eddsa-jcs-2022`).
5. Verify the signature in `proofValue` against the canonicalized payload using the resolved public key.

---

## 7. Witness System

Witnesses are third parties that attest to the existence and content of events at specific points in time.

### 7.1 Witness Types

| Witness Type | Layer | Required | Proof Format |
|-------------|-------|----------|-------------|
| HTTP Witness | webvh | No | `DataIntegrityProof` with `eddsa-jcs-2022` |
| Bitcoin Witness | btco | Yes (exactly 1) | `DataIntegrityProof` with `bitcoin-ordinals-2024` |

### 7.2 HTTP Witness Proof

An HTTP witness is a web service that signs attestations for `did:webvh` events.

```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "eddsa-jcs-2022",
  "created": "2026-02-15T08:01:00Z",
  "verificationMethod": "did:web:witness.example.com#key-0",
  "proofPurpose": "assertionMethod",
  "proofValue": "z4FXQK..."
}
```

HTTP witnesses are OPTIONAL but RECOMMENDED for `did:webvh` assets. Multiple witnesses increase confidence in event timing.

### 7.3 Bitcoin Witness Proof

A Bitcoin witness is the blockchain itself, providing immutable proof that data was inscribed at a specific block height.

```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "bitcoin-ordinals-2024",
  "created": "2026-03-01T14:30:00Z",
  "verificationMethod": "did:btco:1234567890#key-0",
  "proofPurpose": "assertionMethod",
  "proofValue": "z5ABCD...",
  "bitcoinWitness": {
    "txid": "abc123...",
    "blockHeight": 840000,
    "inscriptionId": "abc123i0",
    "satoshi": "1234567890"
  }
}
```

Bitcoin witness proofs MUST include the `bitcoinWitness` extension with:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `txid` | string | Yes | Bitcoin transaction ID of the reveal transaction. |
| `blockHeight` | number | Yes | Block height where the transaction was confirmed. |
| `inscriptionId` | string | Yes | Ordinals inscription identifier. |
| `satoshi` | string | Yes | Satoshi number where the inscription resides. |

---

## 8. Resource Management

Resources are the actual content attached to an asset (files, data, media). They are content-addressed and versioned.

### 8.1 External Reference

Resources are stored externally and referenced by hash.

```json
{
  "digestMultibase": "uSHA256_HASH",
  "mediaType": "image/png",
  "url": ["ipfs://Qm...", "https://cdn.example.com/image.png"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `digestMultibase` | string | Yes | `u` + base64url(SHA-256(content)). Content-addressing hash. |
| `mediaType` | string | No | MIME type of the resource. |
| `url` | `string[]` | No | One or more retrieval URLs. |

### 8.2 Content Addressing

Resources MUST be identified by their SHA-256 content hash:

```
digestMultibase = "u" + base64url_no_pad(SHA-256(raw_content_bytes))
```

This ensures:
- **Integrity:** Content can be verified against the hash.
- **Deduplication:** Identical content produces the same identifier.
- **Location independence:** The resource can be retrieved from any URL and verified.

### 8.3 Resource Versioning

When a resource is updated, a new version is created with a new hash. The previous version's hash is preserved in the version chain.

| Field | Type | Description |
|-------|------|-------------|
| `previousVersionHash` | string | Hash of the prior version. Creates a linked list of versions. |

All versions of a resource are discoverable through the asset's event history. Implementations SHOULD NOT delete prior versions.

---

## 9. Asset Kinds

Assets MAY declare a `kind` that classifies the type of digital artifact they represent. Each kind has a specific manifest schema with required and optional fields.

### 9.1 Defined Kinds

| Kind | Identifier | Description |
|------|-----------|-------------|
| App | `originals:kind:app` | Executable application |
| Agent | `originals:kind:agent` | AI agent or autonomous system |
| Module | `originals:kind:module` | Reusable code library |
| Dataset | `originals:kind:dataset` | Structured data collection |
| Media | `originals:kind:media` | Image, audio, or video |
| Document | `originals:kind:document` | Text document |

### 9.2 Base Manifest

All kinds share a base manifest structure:

```json
{
  "name": "My Asset",
  "version": "1.0.0",
  "description": "A short description",
  "resources": [{ "digestMultibase": "u...", "mediaType": "..." }],
  "dependencies": [{ "did": "did:peer:...", "version": "^1.0.0" }],
  "tags": ["tag1", "tag2"],
  "author": {
    "name": "Alice",
    "did": "did:peer:4zQm...",
    "email": "alice@example.com"
  },
  "license": "MIT"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Asset name. |
| `version` | string | Yes | Semantic version (X.Y.Z). |
| `description` | string | No | Short description. |
| `resources` | `AssetResource[]` | Yes | Attached resources. |
| `dependencies` | `DependencyRef[]` | No | DIDs of dependency Originals, with version constraints. |
| `tags` | `string[]` | No | Freeform tags for discoverability. |
| `author` | object | No | Creator information. |
| `license` | string | No | SPDX license identifier. |

### 9.3 Kind-Specific Fields

#### 9.3.1 App

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runtime` | `"node"` \| `"browser"` \| `"deno"` \| `"bun"` | Yes | Target runtime. |
| `entrypoint` | string | Yes | Resource ID of the entry point. |
| `runtimeVersion` | string | No | Required runtime version. |
| `permissions` | `string[]` | No | Required permissions. |
| `platforms` | `string[]` | No | Supported platforms. |

#### 9.3.2 Agent

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `capabilities` | `string[]` | Yes | Skills or functions the agent provides. |
| `model` | object | No | AI model configuration (provider, name, version). |
| `inputTypes` | `string[]` | No | Accepted input MIME types. |
| `outputTypes` | `string[]` | No | Produced output MIME types. |

#### 9.3.3 Dataset

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `format` | string | Yes | Data format (e.g., `"csv"`, `"json"`, `"parquet"`). |
| `schema` | object | No | Data schema definition. |
| `recordCount` | number | No | Number of records. |

#### 9.3.4 Media

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mediaType` | string | Yes | Primary MIME type. |
| `dimensions` | object | No | Width/height for images and video. |
| `duration` | number | No | Duration in seconds for audio/video. |

### 9.4 Validation

Implementations SHOULD validate manifests against the expected schema for the declared kind. Validation produces:

- **Errors:** Blocking issues that prevent the asset from being created or migrated.
- **Warnings:** Non-blocking issues that indicate potential problems.

---

## 10. Verifiable Credentials

The Originals Protocol uses [W3C Verifiable Credentials](https://www.w3.org/TR/vc-data-model/) to record provenance attestations.

### 10.1 Credential Structure

```json
{
  "@context": [
    "https://www.w3.org/2018/credentials/v1",
    "https://pichu.originals.build/context"
  ],
  "type": ["VerifiableCredential", "ResourceCreated"],
  "issuer": "did:peer:4zQm...",
  "issuanceDate": "2026-01-20T12:00:00Z",
  "credentialSubject": {
    "id": "did:peer:4zQm...",
    "resourceHash": "uSHA256...",
    "mediaType": "image/png"
  },
  "proof": {
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-jcs-2022",
    "created": "2026-01-20T12:00:00Z",
    "verificationMethod": "did:peer:4zQm...#key-0",
    "proofPurpose": "assertionMethod",
    "proofValue": "z3FXQ..."
  }
}
```

### 10.2 Credential Types

| Type | Issued When | Subject |
|------|------------|---------|
| `ResourceCreated` | Resource added to asset | Resource hash, media type |
| `ResourceUpdated` | Resource version created | New hash, previous hash |
| `MigrationCompleted` | Asset migrates layers | Source DID, target DID, layers |
| `OwnershipTransferred` | `did:btco` asset transferred | Asset DID, new owner address |
| `KeyRecoveryCredential` | Key rotation or recovery | Old key, new key, reason |

### 10.3 Signing

Credentials MUST be signed using JSON-LD Data Integrity proofs. JWT-encoded credentials MUST NOT be used.

Supported signing algorithms:

- **EdDSA (Ed25519):** Primary signing algorithm. Used for all credential types.
- **BBS+ (Bls12381G2):** Used when selective disclosure is required. Enables holders to derive proofs revealing only chosen fields.

### 10.4 Selective Disclosure

Credentials signed with BBS+ support selective disclosure:

1. **Issuer** signs the full credential using BBS+ cryptosuite.
2. **Holder** creates a derived proof revealing only selected fields.
3. **Verifier** validates the derived proof without learning undisclosed fields.

This is a zero-knowledge proof: the verifier learns only the disclosed fields and that they were signed by the issuer.

### 10.5 Credential Status

Credentials MAY include a `credentialStatus` field for revocation or suspension, using the [W3C Bitstring Status List](https://www.w3.org/TR/vc-bitstring-status-list/) mechanism.

```json
{
  "credentialStatus": {
    "type": "BitstringStatusListEntry",
    "statusPurpose": "revocation",
    "statusListIndex": "42",
    "statusListCredential": "https://example.com/status/1"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `statusPurpose` | `"revocation"` \| `"suspension"` | Whether the credential can be revoked or suspended. |
| `statusListIndex` | string | Bit position in the status list. |
| `statusListCredential` | string | URL to the status list credential. |

The status list is a GZIP-compressed, base64-encoded bitstring. Each bit position corresponds to a credential. A `1` bit means the credential is revoked (or suspended).

---

## 11. Bitcoin Integration

### 11.1 Commit-Reveal Pattern

Bitcoin inscriptions use a two-phase commit-reveal protocol to protect against front-running attacks.

```
Phase 1: COMMIT
  1. Select UTXOs for inscription.
  2. Create commit transaction (locks a specific satoshi).
  3. Broadcast and wait for confirmation.

Phase 2: REVEAL
  1. Spend the commit output.
  2. Create reveal transaction (inscribes data on the locked satoshi).
  3. Data becomes an immutable Ordinal inscription.
```

**Why two phases?** If inscription were a single transaction, a miner could observe the data in the mempool and inscribe it first on a different satoshi (front-running). The commit phase locks a specific satoshi before the data is revealed.

### 11.2 Inscription Data

Inscriptions carry the following data:

| Content Type | Data | Description |
|-------------|------|-------------|
| `application/did+json` | DID Document | For `did:btco` creation |
| `application/json` | CEL Event | For provenance logging |
| `*/*` | Arbitrary data | For general resource inscription |

### 11.3 UTXO Selection

Implementations MUST use ordinal-aware UTXO selection:

1. **Identify cardinal UTXOs** (UTXOs without existing inscriptions) for fee funding.
2. **Identify the target satoshi** for inscription.
3. **Ensure outputs meet the dust limit** (546 satoshis minimum).
4. **Mark resource vs. protocol UTXOs** to avoid accidentally spending inscribed satoshis.

### 11.4 Fee Estimation

Fee estimation follows a priority hierarchy:

1. **FeeOracleAdapter** (if configured): Dynamic fee estimation from an external service.
2. **OrdinalsProvider.estimateFee()**: Provider-specific estimation.
3. **User-provided feeRate**: Explicit sat/vB rate passed by the caller.

Implementations SHOULD warn when fee rates are unusually high or low.

### 11.5 Satoshi Validation

Before any Bitcoin operation:

- Satoshi numbers MUST be validated as within Bitcoin's total supply (0 to 2,099,999,997,690,000).
- Bitcoin addresses MUST be validated for format correctness (P2PKH, P2WPKH, P2WSH, P2TR).
- Fee rates MUST be positive integers.

### 11.6 Transfer

Transferring a `did:btco` asset:

1. Create a Bitcoin transaction moving the inscribed satoshi to the recipient's address.
2. Update the DID document to reflect the new controller.
3. Append a transfer event to the CEL.
4. Issue an `OwnershipTransferred` credential.

---

## 12. Network Deployments

The Originals Protocol defines three deployment tiers, each mapping a WebVH domain to a Bitcoin network.

### 12.1 Network Tiers

| Network | Domain | Bitcoin Network | Stability | Version Constraint |
|---------|--------|----------------|-----------|-------------------|
| **pichu** | `pichu.originals.build` | mainnet | Production | Major versions only (X.0.0) |
| **cleffa** | `cleffa.originals.build` | signet | Staging | Minor versions (X.Y.0) |
| **magby** | `magby.originals.build` | regtest | Development | All versions (X.Y.Z) |

### 12.2 Network-Bitcoin Mapping

The WebVH network determines the Bitcoin network automatically:

- `magby` -> `regtest`
- `cleffa` -> `signet`
- `pichu` -> `mainnet`

Implementations MUST NOT allow cross-network operations (e.g., a `did:webvh` on `magby.originals.build` MUST NOT produce a `did:btco` on mainnet).

### 12.3 Version Validation

Each network enforces semantic versioning constraints on protocol versions:

- **pichu:** MUST reject versions with non-zero minor or patch (e.g., `1.0.0` accepted, `1.1.0` rejected).
- **cleffa:** MUST reject versions with non-zero patch (e.g., `1.1.0` accepted, `1.1.1` rejected).
- **magby:** MUST accept all valid semantic versions.

### 12.4 Context URLs

Each network serves a JSON-LD context document at:

```
https://{domain}/context
```

All three networks serve identical context document content. The network-specific URL ensures proper DID resolution and document validation within each environment.

### 12.5 DID Resolution by Network

| Network | DID:WebVH Resolution | DID:BTCO Format |
|---------|---------------------|-----------------|
| pichu | `https://pichu.originals.build/.well-known/did.jsonl` | `did:btco:{satoshi}` |
| cleffa | `https://cleffa.originals.build/.well-known/did.jsonl` | `did:btco:sig:{satoshi}` |
| magby | `https://magby.originals.build/.well-known/did.jsonl` | `did:btco:reg:{satoshi}` |

---

## 13. Key Management

### 13.1 Supported Key Types

| Type | Curve | OID | Primary Use |
|------|-------|-----|------------|
| ES256K | secp256k1 | - | Bitcoin operations |
| Ed25519 | Ed25519 | - | VC signing, DID operations, CEL proofs |
| ES256 | P-256 (secp256r1) | - | General cryptography |

### 13.2 Key Lifecycle

1. **Generation:** A key pair is created using the configured key type.
2. **Registration:** The key is stored in the implementation's key store.
3. **Usage:** The private key signs proofs; the public key is published in DID documents.
4. **Rotation:** A new key pair replaces the old one. A `KeyRecoveryCredential` records the rotation.

### 13.3 External Signer Interface

For production deployments, private keys SHOULD NOT be held in application memory. The protocol defines an external signer interface for integration with hardware security modules (HSMs), cloud key management services (KMS), and other secure key stores.

```typescript
interface ExternalSigner {
  sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }>;

  getVerificationMethodId(): string | Promise<string>;
}
```

Implementations SHOULD support external signers for all signing operations. When an external signer is provided, the implementation MUST NOT require a local key pair for the same DID.

### 13.4 Key Storage Security

- Private keys MUST be encrypted at rest when stored locally.
- Implementations MUST NOT log private key material.
- When `sanitizeLogs` is enabled, implementations MUST redact key material from all log output.

---

## 14. Security Considerations

### 14.1 Hash Chain Integrity

The CEL hash chain is the primary defense against tampering. Verifiers MUST:

1. Recompute every `previousEvent` hash and reject logs where any hash does not match.
2. Verify every proof signature against the declared verification method.
3. Confirm that verification methods are authorized in the controller's DID document.

### 14.2 Front-Running Protection

The commit-reveal pattern for Bitcoin inscriptions prevents miners and mempool observers from front-running inscription data. Implementations MUST use commit-reveal for all inscription operations.

### 14.3 Key Compromise

If a controller's private key is compromised:

1. Rotate to a new key immediately.
2. Issue a `KeyRecoveryCredential` documenting the rotation.
3. For `did:webvh` assets, update the DID document via the version-history log.
4. For `did:btco` assets, create a new inscription with the updated DID document.

### 14.4 Witness Trust

Witnesses provide temporal attestation, not content validation. A witness proof means the witness observed the event at the declared time -- it does not mean the witness endorses the content.

Relying parties SHOULD evaluate witness credibility independently. Multiple independent witnesses increase confidence in event timing.

### 14.5 Resource Integrity

Content-addressed resources are self-verifying. Implementations MUST verify that fetched content matches the declared `digestMultibase` hash before accepting it.

### 14.6 Deactivation Finality

Deactivation is irreversible by design. Implementations MUST enforce this at the protocol level by rejecting any events appended after a `deactivate` event.

---

## 15. Conformance

### 15.1 Conformance Levels

**Level 1 -- Core (REQUIRED):**
- Support `did:peer` creation and `peer`-layer operations.
- Implement CEL with hash chain verification.
- Support `eddsa-jcs-2022` cryptosuite.
- Validate Multikey-encoded keys.
- Enforce unidirectional migration rules.

**Level 2 -- Web Discovery (RECOMMENDED):**
- Support `did:webvh` creation and resolution.
- Implement peer-to-webvh migration.
- Support HTTP witness proofs.
- Serve DID documents as JSONL version-history logs.

**Level 3 -- Bitcoin Anchoring (OPTIONAL):**
- Support `did:btco` creation and resolution.
- Implement webvh-to-btco migration.
- Support commit-reveal inscription pattern.
- Support `bitcoin-ordinals-2024` cryptosuite.
- Support asset transfer via Bitcoin transactions.

### 15.2 Interoperability

Conforming implementations MUST:

1. Produce valid CEL logs that any other conforming implementation can verify.
2. Use Multikey encoding for all keys (never JWK).
3. Use JSON-LD Data Integrity proofs (never JWT).
4. Canonicalize using JCS (RFC 8785) for hash computation.
5. Use RFC 3339 timestamps.

---

## 16. References

### Normative References

- [RFC 2119: Key words for use in RFCs](https://datatracker.ietf.org/doc/html/rfc2119)
- [RFC 3339: Date and Time on the Internet: Timestamps](https://datatracker.ietf.org/doc/html/rfc3339)
- [RFC 8785: JSON Canonicalization Scheme (JCS)](https://datatracker.ietf.org/doc/html/rfc8785)
- [W3C DID Core Specification](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials Data Model](https://www.w3.org/TR/vc-data-model/)
- [W3C Data Integrity 1.0](https://w3c.github.io/vc-data-integrity/)
- [W3C CCG Cryptographic Event Log](https://w3c-ccg.github.io/cel-spec/)
- [W3C Bitstring Status List](https://www.w3.org/TR/vc-bitstring-status-list/)

### Informative References

- [Multibase Specification](https://www.w3.org/TR/multibase/)
- [Multicodec Table](https://github.com/multiformats/multicodec/blob/master/table.csv)
- [Bitcoin Ordinals Protocol](https://docs.ordinals.com/)
- [did:peer Specification](https://identity.foundation/peer-did-method-spec/)
- [did:webvh Specification](https://w3c-ccg.github.io/did-method-webvh/)
- [Originals CEL Application Specification](../docs/ORIGINALS_CEL_SPEC.md)

---

## Appendix A: Example -- Full Asset Lifecycle

This appendix traces a complete asset lifecycle from creation through Bitcoin inscription.

### A.1 Create (did:peer)

```json
{
  "type": "create",
  "data": {
    "name": "Sunset Photograph",
    "did": "did:peer:4zQmR8abc...",
    "layer": "peer",
    "kind": "originals:kind:media",
    "resources": [
      {
        "digestMultibase": "uB4sF7qX2kLm...",
        "mediaType": "image/jpeg",
        "url": ["ipfs://QmPhotograph..."]
      }
    ],
    "createdAt": "2026-01-15T10:00:00Z"
  },
  "proof": [{
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-jcs-2022",
    "created": "2026-01-15T10:00:00Z",
    "verificationMethod": "did:peer:4zQmR8abc...#key-0",
    "proofPurpose": "assertionMethod",
    "proofValue": "z3FXQkcW..."
  }]
}
```

### A.2 Migrate to did:webvh

```json
{
  "type": "update",
  "data": {
    "sourceDid": "did:peer:4zQmR8abc...",
    "targetDid": "did:webvh:pichu.originals.build:abc123",
    "layer": "webvh",
    "domain": "pichu.originals.build",
    "updatedAt": "2026-02-01T14:00:00Z"
  },
  "previousEvent": "uHx7kM2pQ...",
  "proof": [
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "created": "2026-02-01T14:00:00Z",
      "verificationMethod": "did:webvh:pichu.originals.build:abc123#key-0",
      "proofPurpose": "assertionMethod",
      "proofValue": "z4ABCde..."
    }
  ]
}
```

### A.3 Migrate to did:btco

```json
{
  "type": "update",
  "data": {
    "sourceDid": "did:webvh:pichu.originals.build:abc123",
    "targetDid": "did:btco:1928374650",
    "layer": "btco",
    "txid": "def456...",
    "inscriptionId": "def456i0",
    "satoshi": "1928374650",
    "blockHeight": 841500,
    "updatedAt": "2026-03-01T09:00:00Z"
  },
  "previousEvent": "uTr9wLkP...",
  "proof": [
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "created": "2026-03-01T09:00:00Z",
      "verificationMethod": "did:btco:1928374650#key-0",
      "proofPurpose": "assertionMethod",
      "proofValue": "z5XYZab..."
    },
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "bitcoin-ordinals-2024",
      "created": "2026-03-01T09:00:00Z",
      "verificationMethod": "did:btco:1928374650#key-0",
      "proofPurpose": "assertionMethod",
      "proofValue": "z6QRStu...",
      "bitcoinWitness": {
        "txid": "def456...",
        "blockHeight": 841500,
        "inscriptionId": "def456i0",
        "satoshi": "1928374650"
      }
    }
  ]
}
```

---

## Appendix B: JSON-LD Context

The Originals Protocol defines a JSON-LD context served at each network's context URL. This context extends the W3C credentials context with Originals-specific terms:

- `OriginalAsset` -- Type for Originals assets
- `ResourceCreated`, `ResourceUpdated` -- Credential types for resource events
- `MigrationCompleted` -- Credential type for layer migrations
- `OwnershipTransferred` -- Credential type for Bitcoin transfers
- `bitcoinWitness` -- Extension for Bitcoin witness proof data
- `digestMultibase` -- Content-addressing hash for resources
- `layer` -- Trust layer identifier
- `kind` -- Asset type classification

The full context document is available at `https://{network}.originals.build/context`.
