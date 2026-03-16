# BTCO DID Linked Resources Specification

**Version:** 1.0.0
**Status:** Draft
**Date:** March 2026
**Editors:** Originals Protocol Team
**Latest Draft:** [https://identity.foundation/labs-ordinals-plus/btco-did-linked-resources](https://identity.foundation/labs-ordinals-plus/btco-did-linked-resources)
**SDK Compatibility:** @originals/sdk v1.9.0+

---

## Abstract

This specification defines how resources (files, data, media) are linked to `did:btco` identifiers via Ordinals inscriptions. Resources are identified by DID URL paths (`did:btco:<sat>/[index]`), organized into collections, and addressed through a structured path scheme. The specification covers resource identification, collection types, pagination, content-addressed versioning, and metadata endpoints.

---

## Status of This Document

This is a draft specification produced by the Originals Protocol project in collaboration with the Decentralized Identity Foundation (DIF). It is intended for review and implementation feedback.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Resource Identification](#3-resource-identification)
4. [Resource Model](#4-resource-model)
5. [Collection Types](#5-collection-types)
6. [Pagination](#6-pagination)
7. [Resource Versioning](#7-resource-versioning)
8. [Resource Validation](#8-resource-validation)
9. [Metadata Endpoints](#9-metadata-endpoints)
10. [Canonicalization](#10-canonicalization)
11. [Security Considerations](#11-security-considerations)
12. [Conformance](#12-conformance)
13. [References](#13-references)

---

## 1. Introduction

### 1.1 Purpose

Digital assets inscribed on Bitcoin via Ordinals are more than just identifiers — they carry resources: images, documents, datasets, code, and other content. This specification defines a structured way to address, organize, and version these resources using DID URL paths, enabling interoperable resource discovery and retrieval across implementations.

### 1.2 Design Goals

1. **DID-native addressing.** Resources are addressed via DID URL paths, not opaque identifiers.
2. **Content integrity.** Resources are content-addressed via SHA-256 hashes.
3. **Version history.** Resource updates create a hash-linked chain of versions.
4. **Collection flexibility.** Multiple collection types support different organizational models.
5. **Paginated access.** Large collections are navigable via cursor-based pagination.

### 1.3 Relationship to BTCO DID Method

This specification extends the [BTCO DID Method](./btco-did-method-v1.md) with resource addressing. A `did:btco` identifier can carry multiple inscriptions on the same satoshi, each representing a resource. This specification defines how those resources are identified, organized, and retrieved.

---

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

| Term | Definition |
|------|-----------|
| **Resource** | Content (file, data, media) linked to a `did:btco` identifier via an inscription. |
| **Resource index** | The zero-based position of a resource inscription on a satoshi, ordered by inscription sequence. |
| **Collection** | A grouping of resources, organized by heritage, controller, or curation. |
| **Heritage collection** | Resources related by parent-child inscription relationships. |
| **Controller collection** | Resources grouped by wallet address control. |
| **Curated collection** | A manually assembled list of resources described by a Verifiable Credential. |
| **Content hash** | The SHA-256 digest of a resource's raw content bytes, encoded as multibase. |
| **Version chain** | A linked list of resource versions connected by `previousVersionHash` references. |

---

## 3. Resource Identification

### 3.1 DID URL Path Addressing

Resources are identified by appending a path to the `did:btco` identifier. The primary addressing scheme uses the inscription index on the satoshi:

```
did:btco:<sat-number>/[index]
```

**Examples:**
```
did:btco:1234567890/0     — First inscription (typically the DID Document)
did:btco:1234567890/1     — Second inscription (first resource)
did:btco:1234567890/2     — Third inscription (second resource)
```

The index is zero-based and corresponds to the inscription order on the satoshi. Index `0` is typically the DID Document itself.

### 3.2 Special Path Segments

The following path segments have defined semantics:

| Path | Description |
|------|-------------|
| `/{index}` | Direct resource access by inscription index. |
| `/{index}/info` | Structured information about the resource (see [Section 9](#9-metadata-endpoints)). |
| `/{index}/meta` | Full metadata for the resource (see [Section 9](#9-metadata-endpoints)). |
| `/heritage` | Heritage collection root (see [Section 5.1](#51-heritage-collections)). |
| `/heritage/child/{index}` | Child inscription by index within the heritage collection. |
| `/controller` | Controller collection root (see [Section 5.2](#52-controller-collections)). |

### 3.3 Network-Prefixed Addressing

Resource addressing works with network-prefixed DIDs:

```
did:btco:sig:9876543210/0        — First resource on signet
did:btco:reg:1111111111/1/info   — Resource info on regtest
```

### 3.4 Internal Identifier Mapping

Implementations MAY use internal identifiers (e.g., UUIDs) for resource management. However, implementations that support DID URL resolution MUST map DID URL paths to internal identifiers and resolve them accordingly.

> **Implementation note:** The SDK uses UUID-based resource IDs internally. A DID-path resolver layer maps `did:btco:<sat>/[index]` paths to internal resource lookups. Both addressing schemes coexist.

---

## 4. Resource Model

### 4.1 Resource Structure

A resource is described by the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier. For DID URL addressing, this is the full DID URL path. |
| `digestMultibase` | string | Yes | Content hash: `u` + base64url_no_pad(SHA-256(raw_bytes)). |
| `mediaType` | string | Yes | MIME type per [RFC 6838](https://datatracker.ietf.org/doc/html/rfc6838). |
| `url` | `string[]` | No | Retrieval URLs. |
| `size` | number | No | Content size in bytes. |
| `created` | string | No | RFC 3339 creation timestamp. |
| `previousVersionHash` | string | No | Content hash of the prior version (see [Section 7](#7-resource-versioning)). |

### 4.2 Content Addressing

Resources MUST be identified by their SHA-256 content hash:

```
digestMultibase = "u" + base64url_no_pad(SHA-256(raw_content_bytes))
```

This scheme ensures:
- **Integrity:** Consumers can verify content against the declared hash.
- **Deduplication:** Identical content produces identical identifiers.
- **Location independence:** Content can be fetched from any URL and verified.

### 4.3 MIME Type Validation

MIME types MUST conform to [RFC 6838](https://datatracker.ietf.org/doc/html/rfc6838) format: `type/subtype`.

Implementations SHOULD validate MIME types against the pattern:
```
^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$
```

### 4.4 Resource Type Inference

Implementations MAY infer a resource type category from the MIME type:

| MIME Prefix | Resource Type |
|-------------|--------------|
| `image/*` | `image` |
| `audio/*` | `audio` |
| `video/*` | `video` |
| `text/*` | `text` |
| All others | `other` |

This inference is informational and does not affect addressing or verification.

---

## 5. Collection Types

Resources on a satoshi can be organized into collections. Three collection types are defined.

### 5.1 Heritage Collections

Heritage collections group resources by parent-child inscription relationships on the same satoshi.

**Path:** `did:btco:<sat>/heritage`

The heritage collection contains all inscriptions that are children of the satoshi's primary inscription. Child inscriptions are addressed by index within the heritage:

```
did:btco:1234567890/heritage              — List all children
did:btco:1234567890/heritage/child/0      — First child inscription
did:btco:1234567890/heritage/child/1      — Second child inscription
```

Heritage collections are determined by the Ordinals protocol's parent-child inscription mechanism. An inscription is a child of another if it references the parent inscription ID in its reveal transaction.

### 5.2 Controller Collections

Controller collections group resources by the wallet address that controls the satoshi.

**Path:** `did:btco:<sat>/controller`

A controller collection includes all inscriptions on satoshis controlled by the same address. This provides a unified view of all resources owned by a single entity.

```
did:btco:1234567890/controller            — All resources under this controller
```

### 5.3 Curated Collections

Curated collections are manually assembled lists of resources, described by a Verifiable Credential at the collection's metadata path.

**Path:** The curated collection is defined by a credential at `did:btco:<sat>/0/meta`.

The credential contains a list of resource references:

```json
{
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    "https://ordinals.plus/v1"
  ],
  "type": ["VerifiableCredential", "CuratedCollectionCredential"],
  "issuer": "did:btco:1234567890",
  "credentialSubject": {
    "id": "did:btco:1234567890",
    "type": "CuratedCollection",
    "name": "My Collection",
    "resources": [
      "did:btco:1234567890/1",
      "did:btco:1234567890/2",
      "did:btco:9876543210/0"
    ]
  }
}
```

Curated collections MAY reference resources across different satoshis.

---

## 6. Pagination

### 6.1 Pagination Parameters

When a collection or resource list exceeds a practical size, implementations MUST support pagination with the following query parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 10 | Number of items per page. MUST be between 1 and 100. |
| `cursor` | string | — | Opaque cursor for the next page. Obtained from the previous response. |
| `order` | `"asc"` \| `"desc"` | `"asc"` | Sort order by inscription sequence. |

### 6.2 Paginated Response

A paginated response MUST include:

```json
{
  "items": [ ... ],
  "pagination": {
    "total": 250,
    "limit": 10,
    "cursor": "eyJpZCI6MTB9",
    "hasMore": true
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `items` | array | Yes | The resource items for this page. |
| `pagination.total` | number | SHOULD | Total number of items in the collection. |
| `pagination.limit` | number | Yes | The requested page size. |
| `pagination.cursor` | string | Yes (if `hasMore`) | Cursor for the next page. |
| `pagination.hasMore` | boolean | Yes | Whether more items exist beyond this page. |

### 6.3 Cursor Encoding

The cursor value is an opaque string. Implementations MAY use any encoding. Clients MUST NOT interpret or construct cursor values — they MUST only pass values received from previous responses.

---

## 7. Resource Versioning

### 7.1 Content-Addressed Version Chains

When a resource is updated, a new version is created with a new content hash. The new version links to the previous version via `previousVersionHash`, forming a hash-linked chain:

```
Version 3: { digestMultibase: "uC...", previousVersionHash: "uB..." }
    ↓
Version 2: { digestMultibase: "uB...", previousVersionHash: "uA..." }
    ↓
Version 1: { digestMultibase: "uA...", previousVersionHash: null }
```

### 7.2 Version Chain Rules

1. The first version of a resource MUST have `previousVersionHash` set to `null` or omitted.
2. Subsequent versions MUST set `previousVersionHash` to the `digestMultibase` of the immediately prior version.
3. Implementations MUST verify version chain integrity by checking that each `previousVersionHash` matches a known resource version.
4. Implementations SHOULD NOT delete prior versions. All versions SHOULD remain retrievable.

### 7.3 Version History

Implementations SHOULD provide a method to retrieve the full version history of a resource, returning all versions in chronological order.

> **Implementation note:** The SDK's `ResourceManager` provides `getResourceHistory(id)` which returns a `ResourceVersionHistory` including all versions with their content hashes, timestamps, and change descriptions.

### 7.4 Inscription-Based Versioning

In addition to content-addressed version chains, the inscription order on a satoshi provides an implicit version history. The latest inscription is the current version. Earlier inscriptions represent prior versions.

Both versioning mechanisms (hash chains and inscription ordering) SHOULD be supported. Hash chains provide stronger integrity guarantees because they are cryptographically verifiable independent of the indexer.

---

## 8. Resource Validation

### 8.1 Validation Pipeline

Implementations SHOULD validate resources before inscription. The validation pipeline includes:

1. **Content validation:** Content MUST NOT be null or empty.
2. **MIME type validation:** The `mediaType` MUST be a valid MIME type per RFC 6838.
3. **Size validation:** Content size MUST NOT exceed the configured maximum (RECOMMENDED default: 10 MB per resource, configurable).
4. **Hash verification:** The `digestMultibase` MUST match the SHA-256 hash of the content.
5. **Version chain integrity:** If `previousVersionHash` is set, it MUST reference a known prior version.

### 8.2 Validation Result

Validation produces:

| Severity | Description |
|----------|-------------|
| `error` | A blocking issue. The resource MUST NOT be inscribed. |
| `warning` | A non-blocking issue. The resource MAY be inscribed but the issue SHOULD be logged. |

### 8.3 Required Validations

| Check | Severity | Description |
|-------|----------|-------------|
| Non-null content | Error | Content is required. |
| Valid MIME type format | Error | MIME type must match `type/subtype` pattern. |
| Size within limits | Error | Content must not exceed maximum size. |
| Hash matches content | Error | Declared hash must match computed hash. |
| Version chain valid | Warning | `previousVersionHash` should reference a known version. |
| Known MIME type | Warning | MIME type should be a recognized type. |

---

## 9. Metadata Endpoints

### 9.1 `/info` Endpoint

The `/info` path segment returns structured summary information about a resource:

```
GET did:btco:1234567890/1/info
```

Response:

```json
{
  "inscriptionId": "abc123i1",
  "satNumber": "1234567890",
  "mediaType": "image/png",
  "size": 245760,
  "created": "2026-02-15T10:00:00Z",
  "digestMultibase": "uSHA256..."
}
```

### 9.2 `/meta` Endpoint

The `/meta` path segment returns full metadata for a resource, including any associated Verifiable Credentials:

```
GET did:btco:1234567890/1/meta
```

Response:

```json
{
  "inscriptionId": "abc123i1",
  "satNumber": "1234567890",
  "mediaType": "image/png",
  "size": 245760,
  "created": "2026-02-15T10:00:00Z",
  "digestMultibase": "uSHA256...",
  "previousVersionHash": null,
  "credentials": [
    {
      "type": ["VerifiableCredential", "ResourceMetadataCredential"],
      "issuer": "did:btco:1234567890",
      "credentialSubject": { ... }
    }
  ]
}
```

### 9.3 Response Format

Metadata endpoints MUST return `application/json` responses. Implementations MUST NOT require authentication for metadata retrieval on public resources.

---

## 10. Canonicalization

### 10.1 JSON Canonicalization

When resource metadata is used in cryptographic proofs or comparisons, implementations MUST use [JSON Canonicalization Scheme (JCS)](https://datatracker.ietf.org/doc/html/rfc8785) to produce a deterministic byte representation.

### 10.2 Canonicalization vs. Signing

Note the distinction between canonicalization schemes:

- **JCS (RFC 8785):** Used for resource metadata comparison and fingerprinting. Deterministic JSON serialization.
- **RDFC-2019 (RDF Dataset Canonicalization):** Used for JSON-LD credential signing via the `eddsa-rdfc-2022` cryptosuite.

Both schemes serve different purposes and are not interchangeable. JCS operates on JSON; RDFC-2019 operates on RDF datasets derived from JSON-LD.

---

## 11. Security Considerations

### 11.1 Content Integrity

The SHA-256 content hash provides tamper detection. Consumers MUST verify fetched content against the declared `digestMultibase` before trusting it.

### 11.2 Resource Size Limits

Implementations MUST enforce maximum resource sizes to prevent denial-of-service via large inscriptions:
- Per-resource limit: RECOMMENDED 10 MB (configurable).
- Total inscription data limit: RECOMMENDED 4 MB for Bitcoin inscription data.

### 11.3 MIME Type Injection

Malicious MIME types could cause unexpected behavior in consumers. Implementations MUST validate MIME type format and SHOULD reject types with path traversal characters or control characters.

### 11.4 URL Retrieval Security

When fetching resources from `url` fields:
- Implementations MUST validate URL schemes (allow only `https://`).
- Implementations MUST reject URLs targeting private IP ranges, link-local addresses, and localhost.
- Implementations SHOULD enforce timeouts on URL fetches (RECOMMENDED default: 10 seconds).

### 11.5 Version Chain Tampering

An attacker could attempt to insert a fake version into a version chain by referencing a valid `previousVersionHash`. Consumers SHOULD verify the entire chain from the first version and cross-reference with inscription ordering.

---

## 12. Conformance

A conformant implementation MUST:

1. Support resource identification via DID URL paths (`did:btco:<sat>/[index]`).
2. Use SHA-256 content-addressed hashing (`digestMultibase` = `u` + base64url_no_pad(SHA-256(bytes))).
3. Validate MIME types per RFC 6838.
4. Validate content against declared hashes.
5. Support pagination with `limit`, `cursor`, and `order` parameters.
6. Return paginated responses with `items`, `total`, `limit`, `cursor`, and `hasMore` fields.

A conformant implementation SHOULD:

1. Support heritage, controller, and curated collection types.
2. Support content-addressed version chains via `previousVersionHash`.
3. Support `/info` and `/meta` metadata endpoints.
4. Enforce resource size limits.
5. Use JCS for metadata canonicalization in cryptographic contexts.

---

## 13. References

### Normative References

- [W3C DID Core](https://www.w3.org/TR/did-core/) — Decentralized Identifiers specification.
- [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119) — Key words for use in RFCs.
- [RFC 6838](https://datatracker.ietf.org/doc/html/rfc6838) — Media Type Specifications and Registration Procedures.
- [RFC 8785](https://datatracker.ietf.org/doc/html/rfc8785) — JSON Canonicalization Scheme (JCS).

### Informative References

- [Ordinals Protocol](https://docs.ordinals.com/) — Bitcoin Ordinals documentation.
- [BTCO DID Method](./btco-did-method-v1.md) — The `did:btco` DID method specification.
- [BTCO Verifiable Metadata](./btco-verifiable-metadata-v1.md) — Credential types for `did:btco`.
- [Originals Protocol Specification](./originals-protocol-v1.md) — Parent protocol specification.
