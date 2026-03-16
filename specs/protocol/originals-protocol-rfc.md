# Originals Protocol

## RFC: Decentralized Digital Asset Provenance on Bitcoin

**Document Identifier:** originals-protocol-rfc-v1
**Version:** 1.0.0
**Status:** Draft Specification
**Date:** 2026-03-12
**Category:** Standards Track
**Authors:** Onion Originals

---

## Abstract

This specification defines the Originals Protocol, a system for creating, discovering, and transferring digital assets with cryptographically verifiable provenance. Assets progress through three trust layers -- `did:peer`, `did:webvh`, and `did:btco` -- each providing increasing levels of discoverability, permanence, and security. The protocol combines W3C Decentralized Identifiers, Verifiable Credentials, Canonical Event Logs, and Bitcoin Ordinals into a layered architecture where trust is added incrementally.

This document is the normative specification for the Originals Protocol. It consolidates requirements for DID lifecycle management, resource linking, verifiable metadata, and asset migration into a single, self-contained reference.

---

## Status of This Document

This is a Draft Specification. It has not been submitted to any standards body. Feedback is welcome.

This document is intended for submission to the Decentralized Identity Foundation (DIF) or for independent publication. It incorporates content from four companion specifications:

- BTCO DID Method Specification v1.0.0
- BTCO DID Linked Resources Specification v1.0.0
- BTCO Verifiable Metadata Specification v1.0.0
- Originals Protocol Specification v1.0.0

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Trust Layers](#3-trust-layers)
4. [DID Methods](#4-did-methods)
5. [Asset Model](#5-asset-model)
6. [Asset Lifecycle](#6-asset-lifecycle)
7. [Migration](#7-migration)
8. [Canonical Event Log](#8-canonical-event-log)
9. [Resource Management](#9-resource-management)
10. [Linked Resources](#10-linked-resources)
11. [Verifiable Credentials](#11-verifiable-credentials)
12. [Cryptographic Suites](#12-cryptographic-suites)
13. [Credential Verification](#13-credential-verification)
14. [Credential Status](#14-credential-status)
15. [Bitcoin Integration](#15-bitcoin-integration)
16. [Network Deployments](#16-network-deployments)
17. [Key Management](#17-key-management)
18. [Security Considerations](#18-security-considerations)
19. [Privacy Considerations](#19-privacy-considerations)
20. [Conformance](#20-conformance)
21. [References](#21-references)

---

## 1. Introduction

### 1.1 Purpose

Digital assets lack a universal system for establishing authentic provenance without relying on a single trusted authority. The Originals Protocol addresses this by combining Decentralized Identifiers (DIDs), Verifiable Credentials, and cryptographic event logs into a layered system where trust is added incrementally -- and only when the asset's value justifies the cost.

The protocol is designed for creators, collectors, institutions, and applications that need to prove the origin, history, and ownership of digital artifacts.

### 1.2 Design Principles

1. **Progressive trust.** Start free and private; add public discoverability and Bitcoin permanence only when needed.
2. **Cryptographic verifiability.** Every state change is signed and hash-chained. Verification requires no trusted third party.
3. **Content addressing.** Resources are identified by their SHA-256 hash, not by location.
4. **Unidirectional migration.** Assets move forward through trust layers and never backward, preserving the integrity of prior commitments.
5. **Standards alignment.** The protocol builds on W3C DID Core, W3C Verifiable Credentials Data Model 2.0, and Bitcoin Ordinals.

### 1.3 Scope

This specification defines:

- Three trust layers and their DID methods
- The `did:btco` DID method for Bitcoin-anchored identifiers
- Asset data model, lifecycle states, and migration rules
- Resource linking and content-addressed versioning
- Verifiable Credential types and cryptographic proof formats
- Credential verification and status management
- Network deployment topology

This specification does not define:

- Application-level UIs or user experiences
- Specific key custody or wallet implementations
- Bitcoin consensus rules or Ordinals indexer behavior
- Authentication or authorization flows for API access

### 1.4 Notational Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119].

- JSON examples use relaxed formatting for readability. Implementations MUST produce valid JSON per [RFC 8259].
- DID URLs follow the syntax defined in [DID Core].
- Hash values use multibase encoding with the `u` (base64url-no-pad) prefix unless otherwise noted.
- Timestamps use [RFC 3339] format (e.g., `2026-01-20T12:00:00Z`).
- Byte sequences use multibase encoding per the [Multibase] specification.

---

## 2. Terminology

| Term | Definition |
|------|-----------|
| **Asset** | A digital artifact with a DID, zero or more resources, an event log, and lifecycle state. |
| **Controller** | The entity authorized to sign events for an asset, identified by a DID. |
| **Canonical Event Log (CEL)** | An ordered, hash-chained sequence of signed events recording an asset's full history. |
| **Layer** | One of three trust tiers: `peer`, `webvh`, or `btco`. |
| **Migration** | The act of moving an asset from one layer to the next, creating a new DID. |
| **Resource** | A content-addressed file or data blob attached to an asset. |
| **Witness** | A third party that attests to an event at a specific point in time. |
| **Kind** | A typed classification for an asset (e.g., `originals:kind:document`). |
| **Inscription** | Data permanently stored on a Bitcoin satoshi via the Ordinals protocol. |
| **Satoshi** | The smallest unit of Bitcoin (10^-8 BTC), individually trackable via Ordinals theory. |
| **Commit-Reveal** | A two-phase transaction pattern that prevents front-running of inscriptions. |
| **Multikey** | A compact public key encoding using multibase and multicodec prefixes. |

---

## 3. Trust Layers

The Originals Protocol defines three trust layers. Each layer maps to a DID method, a resolution mechanism, and a set of witness requirements. Assets MUST begin in the `peer` layer and MAY migrate forward through `webvh` and `btco`. Reverse migration is prohibited.

### 3.1 Layer 1: `did:peer` (Private Creation)

| Property | Value |
|----------|-------|
| DID method | `did:peer` (numalgo 4) |
| Resolution | Self-contained (DID document encoded in identifier) |
| Cost | Free |
| Witnesses | None required |
| Transferable | No |

The `peer` layer is for private creation and experimentation. The creator is the sole controller. No network connectivity is required. This layer supports offline verification because the DID document is embedded in the identifier.

An asset in the `peer` layer is invisible to anyone who does not possess the DID.

### 3.2 Layer 2: `did:webvh` (Public Discovery)

| Property | Value |
|----------|-------|
| DID method | `did:webvh` |
| Format | `did:webvh:{domain}:{scid}` |
| Resolution | HTTPS GET to `/.well-known/did.jsonl` |
| Cost | ~$25/year (domain hosting) |
| Witnesses | Zero or more HTTP witnesses (OPTIONAL) |
| Transferable | No (portable across domains via DID parameters) |

The `webvh` layer makes assets publicly discoverable. The DID document is hosted as a JSONL version-history log, enabling third parties to resolve the identifier and verify its full history.

The `scid` (Self-Certifying Identifier) in the DID is derived from the source `did:peer` suffix, maintaining cryptographic linkage to the asset's origin.

Key rotation, metadata updates, and witness attestations are recorded as new entries in the version-history log.

### 3.3 Layer 3: `did:btco` (Permanent Ownership)

| Property | Value |
|----------|-------|
| DID method | `did:btco` |
| Format | `did:btco:[network-prefix:]satoshi-number` |
| Resolution | Query Bitcoin blockchain via Ordinals indexer |
| Cost | $75--200 (Bitcoin transaction fees) |
| Witnesses | Exactly one Bitcoin witness (REQUIRED) |
| Transferable | Yes |

The `btco` layer anchors assets permanently on Bitcoin. The DID document is inscribed as an Ordinal on a specific satoshi. Ownership is determined by whoever controls the UTXO containing that satoshi.

This is the only layer where assets are transferable. Transfer creates a new Bitcoin transaction moving the inscribed satoshi to a new address and updates the DID document accordingly.

### 3.4 Layer Comparison

| Property | peer | webvh | btco |
|----------|------|-------|------|
| Privacy | High (invisible) | Medium (public) | Low (public blockchain) |
| Cost | Free | ~$25/year | $75--200 one-time |
| Witnesses required | 0 | 0+ | 1 (Bitcoin) |
| Transferable | No | No | Yes |
| Key rotation | Local | Via version-history log | Via new inscription |
| Resolution | Self-contained | HTTPS | Bitcoin indexer |
| Offline verification | Yes | Yes (with cached log) | Yes (with cached chain) |

---

## 4. DID Methods

### 4.1 `did:peer`

Implementations MUST use `did:peer` numalgo 4 as defined in [DID Peer]. The DID document is encoded directly in the identifier, enabling self-contained resolution without network access.

A `did:peer` identifier is created by:

1. Generating a key pair of the configured type (Ed25519, ES256K, or ES256).
2. Constructing a minimal DID document with one verification method.
3. Encoding the document into the `did:peer:4` identifier per the DID Peer specification.

### 4.2 `did:webvh`

Implementations MUST conform to the [DID Web with Version History] specification. A `did:webvh` identifier is created by migrating from `did:peer`:

1. The `scid` is derived from the source `did:peer` suffix.
2. A DID log (JSONL format) is created containing the initial DID document.
3. The log is hosted at `https://{domain}/.well-known/did.jsonl`.

Updates append new entries to the JSONL log. Each entry is signed by the current controller.

Implementations SHOULD support external signers for key management (see [Section 17](#17-key-management)).

### 4.3 `did:btco`

The `did:btco` method binds Decentralized Identifiers to Bitcoin Ordinals inscriptions. A `did:btco` identifier is permanently anchored to a specific satoshi on the Bitcoin blockchain.

#### 4.3.1 Method Syntax

```
did:btco       = "did:btco:" btco-specific-id
btco-specific-id = [ network-prefix ":" ] satoshi-number
network-prefix = "sig" / "reg"
satoshi-number = 1*DIGIT
```

- Mainnet identifiers omit the network prefix: `did:btco:1234567890`
- Signet identifiers use the `sig` prefix: `did:btco:sig:1234567890`
- Regtest identifiers use the `reg` prefix: `did:btco:reg:1234567890`

Implementations MUST validate that satoshi numbers fall within the valid range for the target network. For mainnet, the maximum supply is 2,099,999,997,690,000 satoshis.

#### 4.3.2 DID Document Structure

A `did:btco` DID document MUST conform to [DID Core] and MUST include at minimum:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:btco:1234567890",
  "controller": "did:btco:1234567890",
  "verificationMethod": [
    {
      "id": "did:btco:1234567890#key-1",
      "type": "Multikey",
      "controller": "did:btco:1234567890",
      "publicKeyMultibase": "z6Mk..."
    }
  ],
  "authentication": ["did:btco:1234567890#key-1"],
  "assertionMethod": ["did:btco:1234567890#key-1"]
}
```

The following fields are REQUIRED:

| Field | Description |
|-------|-------------|
| `@context` | MUST include DID Core context and Multikey context |
| `id` | MUST match the `did:btco` identifier |
| `controller` | MUST be a valid DID |
| `verificationMethod` | MUST contain at least one Multikey entry |
| `authentication` | MUST reference at least one verification method |

The following fields are OPTIONAL:

| Field | Description |
|-------|-------------|
| `assertionMethod` | Verification methods for credential issuance |
| `keyAgreement` | Verification methods for key agreement (e.g., X25519) |
| `service` | Service endpoints |
| `alsoKnownAs` | Migration source DIDs for provenance linking |

All public keys MUST use Multikey encoding (multibase + multicodec). JWK format MUST NOT be used.

#### 4.3.3 CRUD Operations

**Create:** Inscribe the DID document as metadata on a satoshi using the commit-reveal pattern (see [Section 15.1](#151-commit-reveal-pattern)).

**Read (Resolve):** Resolution follows this algorithm:

1. Parse the DID to extract network prefix and satoshi number.
2. Query the Ordinals indexer for inscriptions on that satoshi.
3. If multiple inscriptions exist, select the most recent valid DID document.
4. Validate the document structure against [Section 4.3.2](#432-did-document-structure).
5. Return the DID document and resolution metadata.

Resolution metadata MUST include:

| Field | Description |
|-------|-------------|
| `contentType` | `application/did+json` |
| `inscriptionId` | The Bitcoin inscription identifier |
| `satNumber` | The satoshi number |
| `network` | `mainnet`, `signet`, or `regtest` |

**Update:** Create a new inscription on the same satoshi with the updated DID document. The latest valid inscription takes precedence.

**Deactivate:** Create a new inscription with a `deactivated: true` flag in the metadata. Once deactivated, a DID MUST NOT be reactivated.

---

## 5. Asset Model

### 5.1 Asset Structure

An Originals asset consists of:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `did` | string | Yes | The asset's current DID. Changes on migration. |
| `name` | string | Yes | Human-readable asset name. |
| `layer` | `"peer"` \| `"webvh"` \| `"btco"` | Yes | Current trust layer. |
| `resources` | `AssetResource[]` | Yes | Content-addressed resources (MAY be empty). |
| `eventLog` | `EventLog` | Yes | Canonical Event Log recording the asset's history. |
| `credentials` | `VerifiableCredential[]` | No | Credentials issued about or by this asset. |
| `kind` | string | No | Asset type classification. |
| `manifest` | object | No | Kind-specific metadata. Structure depends on `kind`. |
| `createdAt` | string (RFC 3339) | Yes | Timestamp of creation. |
| `updatedAt` | string (RFC 3339) | Yes | Timestamp of last modification. |
| `deactivatedAt` | string (RFC 3339) | No | Timestamp of deactivation, if deactivated. |

### 5.2 Asset Identity

An asset's identity is its DID. When an asset migrates between layers, its DID changes (e.g., from `did:peer:4zQm...` to `did:webvh:magby.originals.build:abc123`). The migration event in the CEL provides the cryptographic proof that the new DID represents the same asset.

Implementations MUST maintain a continuous chain of migration events linking all DIDs that have represented a given asset.

### 5.3 Asset State

An asset is in exactly one of the following states at any time:

- **Active**: The asset accepts events (create, update, migrate, transfer).
- **Deactivated**: The asset is sealed. No further events are accepted.

There is no "draft" vs "published" distinction at the protocol level. The trust layer determines discoverability, not a separate status flag.

### 5.4 Asset Kinds

Assets MAY declare a `kind` field using the namespace `originals:kind:{type}`. The following kinds are defined:

| Kind | Description | Typical Resources |
|------|-------------|-------------------|
| `originals:kind:document` | Written content (articles, papers, legal documents) | text/markdown, application/pdf |
| `originals:kind:media` | Visual or audio content (images, video, music) | image/*, audio/*, video/* |
| `originals:kind:dataset` | Structured data collections | application/json, text/csv |
| `originals:kind:app` | Software applications | application/wasm, text/javascript |
| `originals:kind:agent` | AI agents or autonomous systems | application/json (config), text/javascript |

Implementations MAY define additional kinds. Custom kinds SHOULD use a reverse-domain namespace (e.g., `com.example:kind:custom`).

---

## 6. Asset Lifecycle

### 6.1 Lifecycle Overview

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

### 6.2 Operations

#### 6.2.1 Create

Creates a new asset in the `peer` layer.

- MUST generate a `did:peer` identifier.
- MUST create a `create` event in the CEL.
- MUST set `layer` to `"peer"`.
- MAY attach initial resources.
- MAY issue initial credentials.

#### 6.2.2 Update

Modifies an active asset's metadata or resources.

- MUST create an `update` event in the CEL.
- MUST NOT change the asset's DID or layer.
- MAY add, remove, or version resources.
- MAY add credentials.

#### 6.2.3 Migrate

Moves an asset forward to the next trust layer. See [Section 7](#7-migration).

#### 6.2.4 Transfer

Transfers ownership of a `did:btco` asset. See [Section 15.3](#153-transfer).

- MUST only occur on the `btco` layer.
- MUST create a `transfer` event in the CEL.
- MUST update the DID document's controller to the new owner.

#### 6.2.5 Deactivate

Permanently seals an asset.

- MUST create a `deactivate` event in the CEL.
- MUST set `deactivatedAt` timestamp.
- MUST NOT allow further events after deactivation.

---

## 7. Migration

### 7.1 Migration Rules

1. Assets MUST begin in the `peer` layer.
2. Migration is strictly forward: `peer` -> `webvh` -> `btco`.
3. Implementations MUST NOT allow skipping layers (e.g., `peer` -> `btco` directly).
4. Implementations MUST NOT allow reverse migration.
5. Each migration creates a `migrate` event in the Canonical Event Log.
6. The source DID and target DID MUST both appear in the migration event for provenance continuity.

### 7.2 Peer to WebVH Migration

When migrating from `did:peer` to `did:webvh`:

1. Implementations MUST derive the `scid` from the `did:peer` suffix.
2. Implementations MUST create a version-history log (JSONL) containing the DID document.
3. Implementations MUST record the migration in the CEL with both the source `did:peer` and target `did:webvh`.
4. Implementations MUST preserve all resources and their content hashes.
5. Implementations SHOULD issue a `MigrationCompleted` credential (see [Section 11.4](#114-lifecycle-event-credentials)).

### 7.3 WebVH to BTCO Migration

When migrating from `did:webvh` to `did:btco`:

1. Implementations MUST inscribe the DID document on a Bitcoin satoshi.
2. Implementations MUST use the commit-reveal pattern for inscription.
3. Implementations MUST record the migration in the CEL with both the source `did:webvh` and target `did:btco`.
4. Implementations MUST preserve all resources and their content hashes.
5. Implementations SHOULD include the source DID in the `alsoKnownAs` field of the new DID document.
6. Implementations SHOULD issue a `MigrationCompleted` credential.

### 7.4 Validation Pipeline

Before executing a migration, implementations MUST run a validation pipeline:

| Validator | Purpose |
|-----------|---------|
| DID Compatibility | Verify the source DID method supports migration to the target method |
| Credential Integrity | Verify all attached credentials have valid proofs |
| Storage Requirements | Verify storage is available for the target layer |
| Lifecycle Rules | Verify migration direction is forward and no layers are skipped |
| Resource Integrity | Verify all resource hashes match their content |

If any validator fails, the migration MUST be aborted. Implementations SHOULD support checkpointing and rollback for failed migrations.

---

## 8. Canonical Event Log

### 8.1 Overview

The Canonical Event Log (CEL) is an ordered, append-only, hash-chained sequence of signed events that records the complete history of an asset. It provides an immutable audit trail from creation through every state change.

### 8.2 Event Structure

Each event in the CEL MUST contain:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Event type: `create`, `update`, `migrate`, `transfer`, `deactivate` |
| `timestamp` | string (RFC 3339) | Yes | When the event occurred |
| `actor` | string (DID) | Yes | Who performed the action |
| `previousHash` | string | No | Hash of the previous event (absent for the first event) |
| `hash` | string | Yes | SHA-256 hash of this event's content |
| `data` | object | Yes | Event-specific payload |
| `proof` | Proof | Yes | Cryptographic signature from the actor |

### 8.3 Hash Chaining

Events are chained by including the `previousHash` of the preceding event. The first event in the log MUST NOT have a `previousHash`. All subsequent events MUST include the `previousHash` of the immediately preceding event.

To verify a CEL:

1. Start with the first event and verify it has no `previousHash`.
2. Verify the `hash` matches SHA-256 of the event content.
3. Verify the `proof` against the `actor`'s public key.
4. For each subsequent event, verify `previousHash` matches the prior event's `hash`.
5. Repeat hash and proof verification for each event.

If any step fails, the CEL is invalid.

### 8.4 Event Types

#### 8.4.1 Create Event

```json
{
  "type": "create",
  "timestamp": "2026-01-20T12:00:00Z",
  "actor": "did:peer:4zQm...",
  "hash": "uBfMq...",
  "data": {
    "did": "did:peer:4zQm...",
    "layer": "peer",
    "name": "My Asset",
    "resources": []
  },
  "proof": { ... }
}
```

#### 8.4.2 Migrate Event

```json
{
  "type": "migrate",
  "timestamp": "2026-02-15T09:30:00Z",
  "actor": "did:peer:4zQm...",
  "previousHash": "uBfMq...",
  "hash": "uXkLp...",
  "data": {
    "fromDID": "did:peer:4zQm...",
    "toDID": "did:webvh:magby.originals.build:abc123",
    "fromLayer": "peer",
    "toLayer": "webvh"
  },
  "proof": { ... }
}
```

#### 8.4.3 Transfer Event

```json
{
  "type": "transfer",
  "timestamp": "2026-03-01T14:00:00Z",
  "actor": "did:btco:1234567890",
  "previousHash": "uXkLp...",
  "hash": "uRtWv...",
  "data": {
    "did": "did:btco:1234567890",
    "fromAddress": "bc1q...",
    "toAddress": "bc1p...",
    "txid": "abc123..."
  },
  "proof": { ... }
}
```

### 8.5 Witness Attestations

A witness attestation is a signed statement from a third party confirming that an event existed at a specific time. Witness attestations are appended to the CEL as separate events of type `witness`.

```json
{
  "type": "witness",
  "timestamp": "2026-02-15T09:31:00Z",
  "actor": "did:web:witness.example.com",
  "previousHash": "uXkLp...",
  "hash": "uMnOp...",
  "data": {
    "attestedEvent": "uXkLp...",
    "witnessType": "http"
  },
  "proof": { ... }
}
```

For `did:btco` assets, the Bitcoin blockchain itself serves as the witness. The inscription transaction provides a timestamp and proof of inclusion.

---

## 9. Resource Management

### 9.1 Resource Structure

A resource is a content-addressed file or data blob attached to an asset.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Logical resource identifier (stable across versions) |
| `type` | string | Yes | Resource type: `image`, `text`, `code`, `data`, etc. |
| `contentType` | string | Yes | MIME type per [RFC 6838] |
| `hash` | string | Yes | SHA-256 digest in multibase format: `u` + base64url-no-pad |
| `size` | number | No | Content size in bytes |
| `url` | string | No | Location where the content can be retrieved |
| `content` | string | No | Inline content (for small resources) |
| `version` | number | No | Version number (default 1) |
| `previousVersionHash` | string | No | Hash of the previous version for chain linking |
| `createdAt` | string (RFC 3339) | No | When this version was created |

### 9.2 Content Addressing

Resources MUST be identified by their SHA-256 content hash. The hash is encoded in multibase `digestMultibase` format:

```
digestMultibase = "u" + base64url_no_pad(SHA-256(content))
```

Implementations MUST validate that a resource's content matches its declared hash before accepting it.

### 9.3 Version Chains

Resources support content-addressed version chains. When a resource is updated:

1. A new resource entry is created with a new `hash`.
2. The `previousVersionHash` field MUST be set to the `hash` of the prior version.
3. The `version` field SHOULD be incremented.
4. The `id` field MUST remain the same across versions.

This creates a hash-linked chain enabling full version history traversal without a central registry.

### 9.4 Resource Integrity During Migration

When an asset migrates between layers:

1. All resource hashes MUST be preserved exactly.
2. Resource content MUST NOT be modified during migration.
3. Implementations MUST verify all resource hashes match their content after migration.

---

## 10. Linked Resources

### 10.1 DID-Path Resource Addressing

For `did:btco` assets, resources MAY be addressed using DID URL paths:

```
did:btco:1234567890/0     (first linked resource)
did:btco:1234567890/1     (second linked resource)
did:btco:1234567890/info  (resource summary)
did:btco:1234567890/meta  (full metadata)
```

The index corresponds to the inscription order on the satoshi.

### 10.2 Special Path Segments

| Path | Description |
|------|-------------|
| `/{index}` | Access a specific linked resource by inscription index |
| `/info` | JSON summary of all linked resources |
| `/meta` | Full metadata for all linked resources |
| `/heritage` | Parent-child inscription relationships |
| `/controller` | Resources grouped by wallet address |

### 10.3 Collections

Resources on `did:btco` identifiers can be organized into collections:

**Heritage Collections:** Automatically derived from parent-child inscription relationships on the same satoshi. A parent inscription and all subsequent inscriptions form a heritage chain.

**Controller Collections:** Resources grouped by the Bitcoin address that controls them. These are dynamic -- they change when inscriptions are transferred.

**Curated Collections:** Manually assembled lists of resources, bound together by a `CuratedCollectionCredential` (see [Section 11.3.4](#1134-curatedcollectioncredential)). Curated collections can span multiple satoshis.

### 10.4 Pagination

When listing resources or collections, implementations MUST support pagination:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 10 | Items per page (max 100) |
| `cursor` | string | - | Opaque cursor for next page |
| `order` | `"asc"` \| `"desc"` | `"asc"` | Sort direction |

Response format:

```json
{
  "items": [ ... ],
  "total": 42,
  "limit": 10,
  "cursor": "eyJ...",
  "hasMore": true
}
```

### 10.5 Metadata Endpoints

**`/info`** returns a JSON summary:

```json
{
  "did": "did:btco:1234567890",
  "totalResources": 3,
  "totalSize": 245760,
  "resourceTypes": ["image/png", "application/json"],
  "latestInscription": "abc123i0"
}
```

**`/meta`** returns full metadata for all resources, including version history and collection membership.

---

## 11. Verifiable Credentials

### 11.1 Base Credential Structure

All Originals Protocol credentials MUST conform to the [W3C Verifiable Credentials Data Model 2.0] and MUST include:

```json
{
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    "https://ordinals.plus/v1"
  ],
  "type": ["VerifiableCredential", "..."],
  "issuer": "did:btco:1234567890",
  "validFrom": "2026-01-20T12:00:00Z",
  "credentialSubject": { ... },
  "proof": { ... }
}
```

Required fields:

| Field | Description |
|-------|-------------|
| `@context` | MUST include VC 2.0 context and Originals context |
| `type` | MUST include `"VerifiableCredential"` plus a specific type |
| `issuer` | DID of the credential issuer |
| `validFrom` | RFC 3339 timestamp |
| `credentialSubject` | Claims about the subject |
| `proof` | Data Integrity proof (see [Section 12](#12-cryptographic-suites)) |

Optional fields:

| Field | Description |
|-------|-------------|
| `id` | Credential identifier |
| `validUntil` | Expiration timestamp |
| `credentialStatus` | Status list entry for revocation/suspension |
| `credentialSchema` | Schema for validation |
| `name` | Human-readable name |
| `description` | Human-readable description |

Implementations MUST use Data Integrity proofs. JWT-based proofs MUST NOT be used.

### 11.2 Credential Chaining

Credentials MAY reference prior credentials to form a verifiable chain:

```json
{
  "credentialSubject": {
    "previousCredential": {
      "id": "urn:uuid:previous-credential-id",
      "type": "ResourceMetadataCredential",
      "digestMultibase": "uBfMq..."
    }
  }
}
```

When a `previousCredential` is present, verifiers SHOULD resolve and verify the referenced credential to establish the full provenance chain.

### 11.3 Inscription Metadata Credentials

These credentials describe properties of inscribed resources.

#### 11.3.1 ResourceMetadataCredential

Describes an inscribed resource's properties:

```json
{
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    "https://ordinals.plus/v1"
  ],
  "type": ["VerifiableCredential", "ResourceMetadataCredential"],
  "issuer": "did:btco:1234567890",
  "validFrom": "2026-01-20T12:00:00Z",
  "credentialSubject": {
    "id": "did:btco:1234567890/0",
    "mediaType": "image/png",
    "digestMultibase": "uBfMq...",
    "size": 245760,
    "name": "Cover Image",
    "created": "2026-01-20T12:00:00Z"
  },
  "proof": { ... }
}
```

#### 11.3.2 CollectionCredential

Describes a collection of resources:

```json
{
  "type": ["VerifiableCredential", "CollectionCredential"],
  "credentialSubject": {
    "id": "did:btco:1234567890",
    "collectionType": "heritage",
    "totalItems": 5,
    "members": [
      "did:btco:1234567890/0",
      "did:btco:1234567890/1"
    ]
  }
}
```

#### 11.3.3 VerifiableCollectibleCredential

Describes a digital collectible with provenance metadata:

```json
{
  "type": ["VerifiableCredential", "VerifiableCollectibleCredential"],
  "credentialSubject": {
    "id": "did:btco:1234567890",
    "name": "Genesis Artifact",
    "creator": "did:btco:9876543210",
    "edition": "1 of 10",
    "medium": "Digital image",
    "created": "2026-01-20T12:00:00Z"
  }
}
```

#### 11.3.4 CuratedCollectionCredential

Binds a manually assembled set of resources into a named collection:

```json
{
  "type": ["VerifiableCredential", "CuratedCollectionCredential"],
  "credentialSubject": {
    "id": "urn:uuid:collection-id",
    "name": "My Curated Collection",
    "curator": "did:btco:1234567890",
    "members": [
      { "id": "did:btco:1111111111/0", "role": "primary" },
      { "id": "did:btco:2222222222/0", "role": "secondary" }
    ],
    "description": "A curated selection of artifacts"
  }
}
```

### 11.4 Lifecycle Event Credentials

These credentials record lifecycle transitions for audit and provenance.

#### 11.4.1 ResourceCreated

```json
{
  "type": ["VerifiableCredential", "ResourceCreated"],
  "credentialSubject": {
    "id": "did:peer:4zQm.../resource-id",
    "resourceId": "resource-id",
    "resourceType": "image",
    "createdAt": "2026-01-20T12:00:00Z",
    "creator": "did:peer:4zQm..."
  }
}
```

#### 11.4.2 ResourceUpdated

```json
{
  "type": ["VerifiableCredential", "ResourceUpdated"],
  "credentialSubject": {
    "id": "did:peer:4zQm.../resource-id",
    "resourceId": "resource-id",
    "updatedAt": "2026-02-01T10:00:00Z",
    "updateReason": "Content revision"
  }
}
```

#### 11.4.3 MigrationCompleted

```json
{
  "type": ["VerifiableCredential", "MigrationCompleted"],
  "credentialSubject": {
    "id": "did:webvh:magby.originals.build:abc123",
    "resourceId": "resource-id",
    "fromLayer": "did:peer",
    "toLayer": "did:webvh",
    "migratedAt": "2026-02-15T09:30:00Z",
    "migrationReason": "Public discovery"
  }
}
```

#### 11.4.4 OwnershipTransferred

```json
{
  "type": ["VerifiableCredential", "OwnershipTransferred"],
  "credentialSubject": {
    "id": "did:btco:1234567890",
    "fromAddress": "bc1q...",
    "toAddress": "bc1p...",
    "transferredAt": "2026-03-01T14:00:00Z",
    "txid": "abc123..."
  }
}
```

---

## 12. Cryptographic Suites

### 12.1 Overview

The Originals Protocol uses Data Integrity proofs per the [W3C Data Integrity] specification. All proofs attach directly to credentials as `proof` objects.

### 12.2 Required Suites

#### 12.2.1 `eddsa-jcs-2022`

**Status:** REQUIRED. All implementations MUST support this suite.

- **Algorithm:** EdDSA (Ed25519)
- **Canonicalization:** JSON Canonicalization Scheme [RFC 8785]
- **Key type:** `Multikey` with prefix `z6Mk` (Ed25519 public key)
- **Proof type:** `DataIntegrityProof`
- **Use case:** General-purpose credential signing

```json
{
  "proof": {
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-jcs-2022",
    "created": "2026-01-20T12:00:00Z",
    "verificationMethod": "did:btco:1234567890#key-1",
    "proofPurpose": "assertionMethod",
    "proofValue": "z3FX..."
  }
}
```

#### 12.2.2 `eddsa-rdfc-2022`

**Status:** RECOMMENDED. Implementations SHOULD support this suite.

- **Algorithm:** EdDSA (Ed25519)
- **Canonicalization:** RDF Dataset Canonicalization [RDFC-1.0]
- **Key type:** `Multikey` with prefix `z6Mk` (Ed25519 public key)
- **Use case:** JSON-LD-aware credential signing with RDF normalization

### 12.3 Optional Suites

#### 12.3.1 `bbs-2023`

**Status:** OPTIONAL.

- **Algorithm:** BBS+ signatures
- **Key type:** `Multikey` with BLS12-381 keys
- **Use case:** Selective disclosure -- holders can reveal only specific claims

BBS+ enables derived proofs where a holder presents a subset of the original credential's claims without revealing the full credential. This is useful for privacy-preserving verification scenarios.

#### 12.3.2 `bitcoin-ordinals-2024`

**Status:** OPTIONAL.

- **Algorithm:** ECDSA over secp256k1
- **Key type:** `Multikey` with prefix `zQ3s` (secp256k1 public key)
- **Use case:** Bitcoin-native attestations where the signer is a Bitcoin key

### 12.4 Proof Construction

When creating a proof:

1. Canonicalize the credential using the suite's canonicalization algorithm.
2. Compute SHA-256 of the canonicalized credential.
3. Compute SHA-256 of the proof options (all proof fields except `proofValue`).
4. Concatenate the two hashes.
5. Sign the concatenated hash with the private key.
6. Encode the signature in multibase format as `proofValue`.

Implementations SHOULD use domain separation in the hash construction to prevent cross-context signature reuse.

### 12.5 Multi-Proof Credentials

A credential MAY carry multiple proofs:

```json
{
  "proof": [
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "verificationMethod": "did:btco:1234567890#key-1",
      "proofPurpose": "assertionMethod",
      "proofValue": "z3FX..."
    },
    {
      "type": "DataIntegrityProof",
      "cryptosuite": "eddsa-jcs-2022",
      "verificationMethod": "did:web:witness.example.com#key-1",
      "proofPurpose": "assertionMethod",
      "proofValue": "z7Yz..."
    }
  ]
}
```

Verifiers MUST verify ALL proofs on a multi-proof credential. The credential is valid only if every proof passes verification.

---

## 13. Credential Verification

### 13.1 Verification Algorithm

Implementations MUST follow this seven-step verification algorithm:

**Step 1: Structure Validation.**
Verify the credential contains all required fields: `@context`, `type`, `issuer`, `credentialSubject`, and `proof`.

**Step 2: Context Validation.**
Verify `@context` includes the W3C VC 2.0 context (`https://www.w3.org/ns/credentials/v2`). Verify `@context` includes the Originals context (`https://ordinals.plus/v1`) for Originals-specific credential types.

**Step 3: Issuer DID Resolution.**
Resolve the `issuer` DID using the appropriate DID method. If resolution fails, the credential is invalid.

**Step 4: Verification Method Resolution.**
Locate the verification method referenced in `proof.verificationMethod` within the resolved DID document. If the method is not found or not authorized for `proof.proofPurpose`, the credential is invalid.

**Step 5: Proof Verification.**
Verify the cryptographic proof using the resolved public key and the suite-specific algorithm. For multi-proof credentials, verify ALL proofs.

**Step 6: Issuer-Satoshi Control Verification (did:btco only).**
For credentials issued by a `did:btco` identifier, verify that the issuer controls the satoshi at the time of issuance. This MAY be verified by checking the Bitcoin UTXO state.

**Step 7: Type-Specific Validation.**
Apply credential-type-specific validation rules. For example, verify that a `MigrationCompleted` credential references valid source and target layers.

### 13.2 Verification Result

Verification MUST return a result object:

```json
{
  "verified": true,
  "issuer": "did:btco:1234567890",
  "credentialType": "ResourceMetadataCredential",
  "proofCount": 1,
  "warnings": []
}
```

If verification fails, the result MUST include an error:

```json
{
  "verified": false,
  "error": "Proof verification failed: invalid signature",
  "step": 5
}
```

---

## 14. Credential Status

### 14.1 Bitstring Status List

Implementations MUST use [W3C Bitstring Status List] for credential revocation and suspension.

A status list is a Verifiable Credential containing a compressed bitstring where each bit position represents a credential's status:

```json
{
  "@context": [
    "https://www.w3.org/ns/credentials/v2"
  ],
  "type": ["VerifiableCredential", "BitstringStatusListCredential"],
  "issuer": "did:btco:1234567890",
  "validFrom": "2026-01-01T00:00:00Z",
  "credentialSubject": {
    "type": "BitstringStatusList",
    "statusPurpose": "revocation",
    "encodedList": "H4sI..."
  },
  "proof": { ... }
}
```

### 14.2 Status Entry

Credentials reference their position in a status list via `credentialStatus`:

```json
{
  "credentialStatus": {
    "id": "https://example.com/status/1#42",
    "type": "BitstringStatusListEntry",
    "statusPurpose": "revocation",
    "statusListIndex": "42",
    "statusListCredential": "https://example.com/status/1"
  }
}
```

### 14.3 Revocation vs Suspension

| Operation | Status Purpose | Reversible | Description |
|-----------|---------------|------------|-------------|
| Revocation | `revocation` | No | Permanent invalidation. The bit is set to 1 and MUST NOT be unset. |
| Suspension | `suspension` | Yes | Temporary invalidation. The bit MAY be toggled between 0 and 1. |

---

## 15. Bitcoin Integration

### 15.1 Commit-Reveal Pattern

All Bitcoin inscriptions MUST use a two-phase commit-reveal pattern to prevent front-running:

**Phase 1: Commit Transaction.**
Create a transaction that commits to the inscription content by paying to a taproot address derived from the content hash. This transaction does not reveal the content.

**Phase 2: Reveal Transaction.**
Create a transaction that spends the commit output and includes the inscription content in the witness data. The inscription is now permanently stored on the blockchain.

The time between commit and reveal SHOULD be minimized to reduce the window for front-running attacks.

### 15.2 Inscription Structure

Inscription data is structured as Bitcoin witness script:

```
OP_FALSE
OP_IF
  OP_PUSH "ord"
  OP_PUSH 1           (content type tag)
  OP_PUSH "application/json"
  OP_PUSH 0           (separator)
  OP_PUSH <content>
OP_ENDIF
```

For DID document inscriptions, the content SHOULD be encoded as CBOR for space efficiency. Implementations MAY use JSON during a transition period.

### 15.3 Transfer

Transferring a `did:btco` asset:

1. Identify the UTXO containing the inscribed satoshi.
2. Create a transaction that moves the satoshi to the new owner's address.
3. Use ordinal-aware UTXO selection to ensure the correct satoshi is transferred.
4. Update the DID document with the new controller.
5. Record the transfer event in the CEL.

Implementations MUST use ordinal-aware UTXO selection to prevent accidental loss of inscribed satoshis.

### 15.4 Fee Estimation

Implementations SHOULD use a tiered fee estimation strategy:

1. **Fee Oracle** (highest priority): An external fee estimation service.
2. **Provider Estimation**: The Ordinals provider's built-in fee estimation.
3. **Caller-Specified**: A fee rate provided by the caller.

Implementations MUST allow the caller to specify a fee rate as a fallback.

### 15.5 Network Support

| Bitcoin Network | DID Prefix | Use Case |
|----------------|------------|----------|
| Mainnet | (none) | Production |
| Signet | `sig` | Testing/staging |
| Regtest | `reg` | Local development |

---

## 16. Network Deployments

### 16.1 WebVH Networks

The protocol defines three WebVH network tiers, each mapped to a corresponding Bitcoin network:

| Network | Domain | Stability | Bitcoin Network |
|---------|--------|-----------|----------------|
| pichu (Production) | `pichu.originals.build` | Major releases only | Mainnet |
| cleffa (Staging) | `cleffa.originals.build` | Minor releases | Signet |
| magby (Development) | `magby.originals.build` | All releases | Regtest |

### 16.2 Version Validation

Each network enforces semantic versioning constraints:

- **pichu**: Only major releases (e.g., 1.0.0, 2.0.0)
- **cleffa**: Major and minor releases (e.g., 1.1.0, 2.5.0)
- **magby**: All versions including patches (e.g., 1.2.3)

### 16.3 Context URLs

Each network serves a protocol context document at:

```
https://{domain}/context
```

All three networks serve the same context document content. Implementations MUST use the context URL corresponding to the configured network.

### 16.4 Bitcoin Network Mapping

When migrating from `did:webvh` to `did:btco`, the Bitcoin network is determined by the WebVH network:

| WebVH Network | Bitcoin Network | DID Format |
|---------------|----------------|------------|
| magby | Regtest | `did:btco:reg:{sat}` |
| cleffa | Signet | `did:btco:sig:{sat}` |
| pichu | Mainnet | `did:btco:{sat}` |

---

## 17. Key Management

### 17.1 Multikey Encoding

All public keys in the Originals Protocol MUST use Multikey encoding. JWK format MUST NOT be used.

Multikey encoding combines multibase and multicodec:

```
publicKeyMultibase = multibase_prefix + multicodec_prefix + raw_key_bytes
```

| Key Type | Multicodec Prefix | Multibase Example |
|----------|-------------------|-------------------|
| Ed25519 | `0xed01` | `z6Mk...` |
| secp256k1 | `0xe701` | `zQ3s...` |
| P-256 (ES256) | `0x8024` | `zDn...` |
| X25519 | `0xec01` | `z6LS...` |

### 17.2 Supported Key Types

| Key Type | Algorithm | Use Case |
|----------|-----------|----------|
| Ed25519 | EdDSA | Credential signing, DID authentication |
| secp256k1 (ES256K) | ECDSA | Bitcoin operations, Bitcoin-native attestations |
| P-256 (ES256) | ECDSA | Interoperability with existing PKI |
| X25519 | ECDH | Key agreement (OPTIONAL) |

### 17.3 External Signer Interface

Implementations SHOULD support external signers for production key management. An external signer abstracts the signing operation from the key material:

```typescript
interface ExternalSigner {
  sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }>;
  getVerificationMethodId(): string;
}
```

This enables integration with hardware security modules (HSMs), cloud key management services (e.g., AWS KMS), and custodial key management platforms (e.g., Turnkey).

When an external signer is configured, implementations MUST NOT require direct access to private key material.

---

## 18. Security Considerations

### 18.1 Front-Running Protection

The commit-reveal pattern (Section 15.1) mitigates front-running attacks where an adversary observes a pending inscription and attempts to inscribe the same content first. The commit transaction locks the content to a specific satoshi before the content is revealed.

### 18.2 Key Compromise

If a key is compromised:

- **did:peer**: Create a new asset. The compromised asset cannot be recovered.
- **did:webvh**: Rotate keys by appending a new entry to the version-history log signed by the current (compromised) key, then immediately appending another entry with the new key. Witness attestations strengthen the rotation.
- **did:btco**: Create a new inscription on the same satoshi with an updated DID document. The latest valid inscription takes precedence.

Implementations SHOULD issue a `KeyRecoveryCredential` documenting the recovery event.

### 18.3 UTXO Management

Ordinal-aware UTXO selection is critical. Implementations MUST NOT spend UTXOs containing inscribed satoshis as fee inputs, which would permanently destroy the inscription.

### 18.4 Inscription Validation

Implementations MUST validate inscription content before accepting it as a DID document. Invalid or malformed documents MUST be rejected during resolution.

### 18.5 Proof Replay Prevention

Proofs SHOULD include domain separation to prevent cross-context signature reuse. The `created` timestamp and `verificationMethod` fields in the proof help bind the signature to a specific context.

### 18.6 Hash Chain Integrity

The CEL's hash chain provides tamper evidence. Any modification to a historical event invalidates all subsequent hashes. Implementations MUST verify the full hash chain when loading a CEL.

### 18.7 Resource Integrity

Content addressing (SHA-256 hashes) ensures that resources cannot be silently modified. Implementations MUST verify resource hashes on every access, not only during migration.

---

## 19. Privacy Considerations

### 19.1 Blockchain Transparency

`did:btco` identifiers are publicly visible on the Bitcoin blockchain. All inscriptions, transfers, and DID documents are permanently recorded. Users SHOULD be informed that migrating to `did:btco` makes their asset history permanently public.

### 19.2 Correlation Risk

Multiple `did:btco` identifiers controlled by the same Bitcoin address can be correlated. Implementations SHOULD use distinct addresses for distinct identities to reduce correlation.

The `alsoKnownAs` field in DID documents explicitly links identities across layers. This is by design for provenance continuity, but users should understand the privacy implications.

### 19.3 Selective Disclosure

BBS+ signatures ([Section 12.3.1](#1231-bbs-2023)) enable holders to reveal only specific claims from a credential. This is RECOMMENDED for credentials containing personal or sensitive data.

### 19.4 did:peer Privacy

Assets in the `did:peer` layer are private by default. The DID is not published anywhere and the asset is invisible to anyone who does not possess the identifier. Migration to `did:webvh` or `did:btco` permanently changes the asset's privacy posture.

### 19.5 Migration Provenance

Migration events create a public link between a private `did:peer` and a public `did:webvh` or `did:btco`. Once migrated, the original `did:peer` identifier is disclosed in the CEL. Implementations SHOULD warn users that migration reveals the creation-layer identity.

---

## 20. Conformance

### 20.1 Conformance Classes

This specification defines three conformance classes:

**Originals Creator (Level 1):**
An implementation that supports `did:peer` asset creation, resource management, and CEL generation. MUST implement Sections 3.1, 5, 6, 8, 9, 12.2.1, and 17.1.

**Originals Publisher (Level 2):**
Extends Level 1 with `did:webvh` support. MUST implement Sections 3.2, 4.2, 7.2, and 11.4.

**Originals Anchorer (Level 3):**
Extends Level 2 with `did:btco` support. MUST implement Sections 3.3, 4.3, 7.3, 10, 11, 13, 15, and 16.

### 20.2 Interoperability Requirements

All conformance levels:

- MUST use Multikey encoding for all public keys (Section 17.1).
- MUST use Data Integrity proofs, not JWT (Section 12).
- MUST use SHA-256 content addressing for resources (Section 9.2).
- MUST use RFC 3339 timestamps.
- MUST support `eddsa-jcs-2022` cryptographic suite (Section 12.2.1).

### 20.3 Extension Points

Implementations MAY extend this specification in the following ways:

- Additional asset kinds (Section 5.4)
- Additional cryptographic suites (Section 12.3)
- Additional credential types (Section 11)
- Custom storage adapters
- Custom witness mechanisms

Extensions MUST NOT conflict with normative requirements of this specification.

---

## 21. References

### 21.1 Normative References

| Reference | Title |
|-----------|-------|
| [RFC 2119] | Key words for use in RFCs to Indicate Requirement Levels |
| [RFC 3339] | Date and Time on the Internet: Timestamps |
| [RFC 6838] | Media Type Specifications and Registration Procedures |
| [RFC 8259] | The JavaScript Object Notation (JSON) Data Interchange Format |
| [RFC 8785] | JSON Canonicalization Scheme (JCS) |
| [DID Core] | W3C Decentralized Identifiers (DIDs) v1.0 |
| [DID Peer] | Peer DID Method Specification |
| [DID Web with Version History] | did:webvh Method Specification |
| [W3C VC Data Model 2.0] | W3C Verifiable Credentials Data Model v2.0 |
| [W3C Data Integrity] | W3C Data Integrity 1.0 |
| [W3C Bitstring Status List] | W3C Bitstring Status List v1.0 |
| [Multibase] | Multibase Data Format |
| [RDFC-1.0] | RDF Dataset Canonicalization |

### 21.2 Informative References

| Reference | Title |
|-----------|-------|
| [Ordinals] | Bitcoin Ordinals Protocol |
| [BBS+] | BBS Signature Scheme |
| [Ed25519] | Edwards-Curve Digital Signature Algorithm (EdDSA) |
| [secp256k1] | SEC 2: Recommended Elliptic Curve Domain Parameters |
| [W3C CCG] | W3C Credentials Community Group |
| [Originals SDK] | @originals/sdk TypeScript implementation |

---

## Appendix A: Complete Asset Lifecycle Example

This example traces an asset from creation through Bitcoin anchoring.

### A.1 Create Asset (did:peer)

```json
{
  "did": "did:peer:4zQmX9...",
  "name": "Genesis Document",
  "layer": "peer",
  "kind": "originals:kind:document",
  "resources": [
    {
      "id": "doc-001",
      "type": "text",
      "contentType": "text/markdown",
      "hash": "uBfMqR3e5kP...",
      "size": 4096,
      "version": 1,
      "createdAt": "2026-01-20T12:00:00Z"
    }
  ],
  "eventLog": {
    "events": [
      {
        "type": "create",
        "timestamp": "2026-01-20T12:00:00Z",
        "actor": "did:peer:4zQmX9...",
        "hash": "uAbc123...",
        "data": {
          "did": "did:peer:4zQmX9...",
          "layer": "peer",
          "name": "Genesis Document"
        },
        "proof": {
          "type": "DataIntegrityProof",
          "cryptosuite": "eddsa-jcs-2022",
          "created": "2026-01-20T12:00:00Z",
          "verificationMethod": "did:peer:4zQmX9...#key-1",
          "proofPurpose": "assertionMethod",
          "proofValue": "z3FX..."
        }
      }
    ]
  },
  "createdAt": "2026-01-20T12:00:00Z",
  "updatedAt": "2026-01-20T12:00:00Z"
}
```

### A.2 Migrate to did:webvh

The `scid` is derived from the `did:peer` suffix. A version-history log is created and hosted.

CEL migration event:

```json
{
  "type": "migrate",
  "timestamp": "2026-02-15T09:30:00Z",
  "actor": "did:peer:4zQmX9...",
  "previousHash": "uAbc123...",
  "hash": "uDef456...",
  "data": {
    "fromDID": "did:peer:4zQmX9...",
    "toDID": "did:webvh:magby.originals.build:zQmX9abc",
    "fromLayer": "peer",
    "toLayer": "webvh"
  },
  "proof": { ... }
}
```

### A.3 Migrate to did:btco

The DID document is inscribed on Bitcoin via commit-reveal. The WebVH source is recorded in `alsoKnownAs`.

Resulting DID document on Bitcoin:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:btco:reg:1234567890",
  "controller": "did:btco:reg:1234567890",
  "alsoKnownAs": [
    "did:peer:4zQmX9...",
    "did:webvh:magby.originals.build:zQmX9abc"
  ],
  "verificationMethod": [
    {
      "id": "did:btco:reg:1234567890#key-1",
      "type": "Multikey",
      "controller": "did:btco:reg:1234567890",
      "publicKeyMultibase": "z6MkhaXg..."
    }
  ],
  "authentication": ["did:btco:reg:1234567890#key-1"],
  "assertionMethod": ["did:btco:reg:1234567890#key-1"]
}
```

### A.4 Transfer Ownership

```json
{
  "type": "transfer",
  "timestamp": "2026-03-01T14:00:00Z",
  "actor": "did:btco:reg:1234567890",
  "previousHash": "uGhi789...",
  "hash": "uJkl012...",
  "data": {
    "did": "did:btco:reg:1234567890",
    "fromAddress": "bcrt1q...",
    "toAddress": "bcrt1p...",
    "txid": "a1b2c3..."
  },
  "proof": { ... }
}
```

---

## Appendix B: Credential Type Summary

| Credential Type | Category | Description |
|----------------|----------|-------------|
| `ResourceMetadataCredential` | Inscription Metadata | Properties of an inscribed resource |
| `CollectionCredential` | Inscription Metadata | Describes a resource collection |
| `VerifiableCollectibleCredential` | Inscription Metadata | Digital collectible provenance |
| `CuratedCollectionCredential` | Inscription Metadata | Manually assembled resource list |
| `ResourceCreated` | Lifecycle Event | Resource first attached to asset |
| `ResourceUpdated` | Lifecycle Event | Resource version changed |
| `MigrationCompleted` | Lifecycle Event | Asset moved between trust layers |
| `OwnershipTransferred` | Lifecycle Event | did:btco transferred to new owner |
| `KeyRecoveryCredential` | Security Event | Key rotation after compromise |
| `BitstringStatusListCredential` | Status | Credential revocation/suspension list |

---

## Appendix C: Multikey Prefix Reference

| Algorithm | Multicodec Code | Multibase Prefix | Example |
|-----------|----------------|------------------|---------|
| Ed25519 Public | `0xed01` | `z6Mk` | `z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK` |
| Ed25519 Private | `0x8026` | `z3u2` | `z3u2...` |
| secp256k1 Public | `0xe701` | `zQ3s` | `zQ3shokFTS3brHcDQrn82RUDfCZnrKMw8zYXy1d34b7h9j` |
| P-256 Public | `0x8024` | `zDn` | `zDnaerDaTF5BXEavCrfRZEk316dp...` |
| X25519 Public | `0xec01` | `z6LS` | `z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc` |

---

## Appendix D: JSON-LD Contexts

### D.1 W3C Contexts

- `https://www.w3.org/ns/did/v1` -- DID Core
- `https://www.w3.org/ns/credentials/v2` -- Verifiable Credentials Data Model 2.0
- `https://w3id.org/security/multikey/v1` -- Multikey
- `https://w3id.org/security/data-integrity/v2` -- Data Integrity

### D.2 Originals Contexts

- `https://ordinals.plus/v1` -- Originals Protocol types and properties

Network-specific context URLs:

- `https://pichu.originals.build/context` (production)
- `https://cleffa.originals.build/context` (staging)
- `https://magby.originals.build/context` (development)

All network-specific context URLs serve the same document content as `https://ordinals.plus/v1`.
