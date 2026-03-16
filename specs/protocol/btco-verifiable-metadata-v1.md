# BTCO Verifiable Metadata Specification

**Version:** 1.0.0
**Status:** Draft
**Date:** March 2026
**Editors:** Originals Protocol Team
**Latest Draft:** [https://identity.foundation/labs-ordinals-plus/btco-vm](https://identity.foundation/labs-ordinals-plus/btco-vm)
**SDK Compatibility:** @originals/sdk v1.9.0+

---

## Abstract

This specification defines the Verifiable Credential types, cryptographic suites, verification procedures, and status mechanisms used with `did:btco` identifiers. It extends the W3C Verifiable Credentials Data Model 2.0 with credential types specific to Bitcoin Ordinals: resource metadata, collections, lifecycle events, and collectibles. Credentials are signed using Data Integrity proofs and support both EdDSA and BBS+ cryptosuites.

---

## Status of This Document

This is a draft specification produced by the Originals Protocol project in collaboration with the Decentralized Identity Foundation (DIF). It is intended for review and implementation feedback.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Base Credential Structure](#3-base-credential-structure)
4. [Credential Types — Inscription Metadata](#4-credential-types--inscription-metadata)
5. [Credential Types — Lifecycle Events](#5-credential-types--lifecycle-events)
6. [Credential Chaining](#6-credential-chaining)
7. [Cryptographic Suites](#7-cryptographic-suites)
8. [Verification Algorithm](#8-verification-algorithm)
9. [Status Mechanism](#9-status-mechanism)
10. [Selective Disclosure](#10-selective-disclosure)
11. [Security Considerations](#11-security-considerations)
12. [Conformance](#12-conformance)
13. [References](#13-references)

---

## 1. Introduction

### 1.1 Purpose

`did:btco` identifiers anchor assets on Bitcoin, but the DID Document alone cannot express rich metadata about those assets — what they contain, who created them, how they've been transferred, or whether they've been revoked. Verifiable Credentials fill this gap by providing cryptographically signed attestations about inscribed resources.

This specification defines two families of credential types:

1. **Inscription metadata credentials** describe what an inscription contains (its resources, collections, and properties).
2. **Lifecycle event credentials** record what has happened to an asset (creation, updates, migration, transfer).

Both families use the same base structure, signing mechanisms, and verification procedures.

### 1.2 Design Goals

1. **W3C alignment.** Full compatibility with the W3C VC Data Model 2.0.
2. **Dual type taxonomy.** Inscription metadata types (from the DIF spec) and lifecycle event types (from the Originals Protocol) coexist.
3. **Interoperable proofs.** Data Integrity proofs using standard cryptosuites, not proprietary schemes.
4. **Revocable.** Credentials can be revoked or suspended via the W3C Bitstring Status List mechanism.
5. **Selective disclosure.** BBS+ signatures enable holders to reveal only chosen fields.

### 1.3 Relationship to Other Specifications

- [BTCO DID Method](./btco-did-method-v1.md) — Defines the `did:btco` identifier that issuers and subjects use.
- [BTCO DID Linked Resources](./btco-did-linked-resources-v1.md) — Defines resource addressing referenced by credentials.
- [Originals Protocol Specification](./originals-protocol-v1.md) — Defines the lifecycle model that lifecycle credentials record.

---

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

| Term | Definition |
|------|-----------|
| **Issuer** | The entity that signs and issues a credential. Identified by a DID. |
| **Subject** | The entity or resource that the credential is about. Identified by a DID or DID URL. |
| **Holder** | The entity that possesses and presents a credential. |
| **Verifier** | The entity that checks a credential's proof and status. |
| **Data Integrity Proof** | A cryptographic proof embedded in the credential per the W3C Data Integrity specification. |
| **Cryptosuite** | A named algorithm for producing and verifying Data Integrity proofs. |
| **Status list** | A bitstring where each position corresponds to a credential's revocation or suspension state. |

---

## 3. Base Credential Structure

### 3.1 Context

All credentials MUST include the W3C Verifiable Credentials v2 context and the Originals context:

```json
{
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    "https://ordinals.plus/v1"
  ]
}
```

Implementations MAY additionally include the network-specific Originals context URL:

```json
"@context": [
  "https://www.w3.org/ns/credentials/v2",
  "https://ordinals.plus/v1",
  "https://pichu.originals.build/context"
]
```

> **Transition note:** The SDK currently uses the older v1 context (`https://www.w3.org/2018/credentials/v1`) in some credential creation paths. Implementations MUST migrate to the v2 context (`https://www.w3.org/ns/credentials/v2`). During the transition period, verifiers SHOULD accept both v1 and v2 contexts.

### 3.2 Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `@context` | `string[]` | MUST include the v2 credentials context and Ordinals context. |
| `type` | `string[]` | MUST include `"VerifiableCredential"` and one or more specific types from Sections 4–5. |
| `issuer` | string | DID of the credential issuer. |
| `validFrom` | string | RFC 3339 timestamp when the credential becomes valid. |
| `credentialSubject` | object | Claims about the subject. MUST include an `id` field. |
| `proof` | object | Data Integrity proof (see [Section 7](#7-cryptographic-suites)). |

### 3.3 Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `validUntil` | string | RFC 3339 timestamp when the credential expires. |
| `credentialStatus` | object | Revocation or suspension status (see [Section 9](#9-status-mechanism)). |
| `credentialSchema` | object | Schema reference for validation. |
| `name` | string | Human-readable credential name. |
| `description` | string | Human-readable description. |

### 3.4 Example

```json
{
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    "https://ordinals.plus/v1"
  ],
  "type": ["VerifiableCredential", "ResourceMetadataCredential"],
  "issuer": "did:btco:1234567890",
  "validFrom": "2026-03-01T12:00:00Z",
  "credentialSubject": {
    "id": "did:btco:1234567890/1",
    "type": "InscriptionResource",
    "mediaType": "image/png",
    "digestMultibase": "uSHA256...",
    "name": "Artwork #42"
  },
  "proof": {
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-jcs-2022",
    "created": "2026-03-01T12:00:00Z",
    "verificationMethod": "did:btco:1234567890#key-0",
    "proofPurpose": "assertionMethod",
    "proofValue": "z3FXQ..."
  }
}
```

---

## 4. Credential Types — Inscription Metadata

These types describe the properties and organization of inscribed resources.

### 4.1 ResourceMetadataCredential

Describes metadata about a specific inscribed resource.

**Type:** `["VerifiableCredential", "ResourceMetadataCredential"]`

**Subject fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | DID URL of the resource (e.g., `did:btco:1234567890/1`). |
| `type` | string | Yes | MUST be `"InscriptionResource"`. |
| `mediaType` | string | Yes | MIME type of the resource content. |
| `digestMultibase` | string | Yes | Content hash. |
| `name` | string | No | Human-readable name. |
| `description` | string | No | Human-readable description. |
| `size` | number | No | Content size in bytes. |

### 4.2 CollectionCredential

Describes a collection of resources.

**Type:** `["VerifiableCredential", "CollectionCredential"]`

**Subject fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | DID URL of the collection (e.g., `did:btco:1234567890/heritage`). |
| `type` | string | Yes | MUST be `"InscriptionCollection"`. |
| `collectionType` | string | Yes | One of: `"heritage"`, `"controller"`, `"curated"`. |
| `name` | string | No | Collection name. |
| `description` | string | No | Collection description. |
| `resourceCount` | number | No | Number of resources in the collection. |

### 4.3 VerifiableCollectibleCredential

Describes a digital collectible with provenance attestation.

**Type:** `["VerifiableCredential", "VerifiableCollectibleCredential"]`

**Subject fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | DID of the collectible. |
| `type` | string | Yes | MUST be `"VerifiableCollectible"`. |
| `creator` | string | Yes | DID of the original creator. |
| `createdAt` | string | Yes | RFC 3339 creation timestamp. |
| `edition` | object | No | Edition information (`number`, `total`). |
| `mediaType` | string | No | MIME type of the primary resource. |

### 4.4 CuratedCollectionCredential

Describes a curated collection assembled by an issuer.

**Type:** `["VerifiableCredential", "CuratedCollectionCredential"]`

**Subject fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | DID URL of the collection. |
| `type` | string | Yes | MUST be `"CuratedCollection"`. |
| `name` | string | Yes | Collection name. |
| `curator` | string | Yes | DID of the curator. |
| `resources` | `string[]` | Yes | Array of DID URLs for included resources. |
| `description` | string | No | Collection description. |

---

## 5. Credential Types — Lifecycle Events

These types record events in an asset's lifecycle. They are specific to the Originals Protocol and complement the inscription metadata types.

### 5.1 ResourceCreated

Issued when a resource is first attached to an asset.

**Type:** `["VerifiableCredential", "ResourceCreated"]`

**Subject fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | DID of the asset. |
| `resourceHash` | string | Yes | Content hash of the created resource. |
| `mediaType` | string | Yes | MIME type of the resource. |
| `createdAt` | string | Yes | RFC 3339 creation timestamp. |

### 5.2 ResourceUpdated

Issued when a resource version is updated.

**Type:** `["VerifiableCredential", "ResourceUpdated"]`

**Subject fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | DID of the asset. |
| `resourceHash` | string | Yes | Content hash of the new version. |
| `previousResourceHash` | string | Yes | Content hash of the prior version. |
| `mediaType` | string | Yes | MIME type. |
| `updatedAt` | string | Yes | RFC 3339 update timestamp. |

### 5.3 MigrationCompleted

Issued when an asset migrates between trust layers.

**Type:** `["VerifiableCredential", "MigrationCompleted"]`

**Subject fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | DID of the asset (target DID). |
| `sourceDid` | string | Yes | DID before migration. |
| `targetDid` | string | Yes | DID after migration. |
| `sourceLayer` | string | Yes | Layer before migration (`peer`, `webvh`). |
| `targetLayer` | string | Yes | Layer after migration (`webvh`, `btco`). |
| `migratedAt` | string | Yes | RFC 3339 migration timestamp. |

### 5.4 OwnershipTransferred

Issued when a `did:btco` asset is transferred to a new owner.

**Type:** `["VerifiableCredential", "OwnershipTransferred"]`

**Subject fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | DID of the asset. |
| `previousOwner` | string | No | DID or address of the previous owner. |
| `newOwner` | string | Yes | Bitcoin address of the new owner. |
| `txid` | string | Yes | Bitcoin transaction ID of the transfer. |
| `transferredAt` | string | Yes | RFC 3339 transfer timestamp. |

### 5.5 Type Taxonomy Relationship

The inscription metadata types (Section 4) and lifecycle event types (Section 5) serve complementary purposes:

| Inscription Metadata Types | Purpose |
|---------------------------|---------|
| ResourceMetadataCredential | What the inscription contains |
| CollectionCredential | How resources are organized |
| VerifiableCollectibleCredential | Provenance of a collectible |
| CuratedCollectionCredential | A curated resource list |

| Lifecycle Event Types | Purpose |
|----------------------|---------|
| ResourceCreated | When a resource was first created |
| ResourceUpdated | When a resource version changed |
| MigrationCompleted | When an asset moved between layers |
| OwnershipTransferred | When a Bitcoin-layer asset changed hands |

Both type families MUST be supported by conformant implementations. They MAY be used together on the same asset.

---

## 6. Credential Chaining

### 6.1 Purpose

Credentials MAY be chained together to form a verifiable provenance sequence. Each credential in the chain references the previous credential by ID and content hash.

### 6.2 Chaining Fields

| Field | Type | Description |
|-------|------|-------------|
| `credentialSubject.previousCredential.id` | string | ID of the previous credential in the chain. |
| `credentialSubject.previousCredential.digestMultibase` | string | Content hash of the previous credential. |

### 6.3 Example

```json
{
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    "https://ordinals.plus/v1"
  ],
  "type": ["VerifiableCredential", "ResourceUpdated"],
  "issuer": "did:btco:1234567890",
  "validFrom": "2026-03-15T10:00:00Z",
  "credentialSubject": {
    "id": "did:btco:1234567890",
    "resourceHash": "uNEW_HASH...",
    "previousResourceHash": "uOLD_HASH...",
    "mediaType": "image/png",
    "updatedAt": "2026-03-15T10:00:00Z",
    "previousCredential": {
      "id": "urn:uuid:abc123",
      "digestMultibase": "uCREDENTIAL_HASH..."
    }
  },
  "proof": { ... }
}
```

### 6.4 Chain Verification

To verify a credential chain:

1. Start from the latest credential.
2. Verify its proof (see [Section 8](#8-verification-algorithm)).
3. Retrieve the credential referenced by `previousCredential.id`.
4. Verify its content hash matches `previousCredential.digestMultibase`.
5. Recursively verify the previous credential.
6. The chain terminates when a credential has no `previousCredential`.

---

## 7. Cryptographic Suites

### 7.1 Required Suite: `eddsa-jcs-2022`

All conformant implementations MUST support the `eddsa-jcs-2022` cryptosuite.

| Property | Value |
|----------|-------|
| Cryptosuite ID | `eddsa-jcs-2022` |
| Curve | Ed25519 |
| Canonicalization | JSON Canonicalization Scheme (JCS), [RFC 8785](https://datatracker.ietf.org/doc/html/rfc8785) |
| Hash | SHA-256 |
| Signature | EdDSA (Ed25519) |
| Key format | Multikey (`z6Mk...`) |

**Proof structure:**

```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "eddsa-jcs-2022",
  "created": "2026-03-01T12:00:00Z",
  "verificationMethod": "did:btco:1234567890#key-0",
  "proofPurpose": "assertionMethod",
  "proofValue": "z3FXQ..."
}
```

### 7.2 Recommended Suite: `eddsa-rdfc-2022`

Implementations SHOULD also support `eddsa-rdfc-2022` for JSON-LD credential signing:

| Property | Value |
|----------|-------|
| Cryptosuite ID | `eddsa-rdfc-2022` |
| Curve | Ed25519 |
| Canonicalization | RDFC-2019 (RDF Dataset Canonicalization) |
| Hash | SHA-256 |
| Signature | EdDSA (Ed25519) |
| Key format | Multikey (`z6Mk...`) |

> **Implementation note:** The SDK currently implements `eddsa-rdfc-2022` as its primary cryptosuite. Both `eddsa-jcs-2022` and `eddsa-rdfc-2022` are valid Data Integrity suites using Ed25519. `eddsa-jcs-2022` is RECOMMENDED for new credentials because JCS canonicalization is simpler and does not require a JSON-LD processor. Verifiers MUST support both suites.

### 7.3 Optional Suite: BBS+ (`bbs-2023`)

Implementations MAY support the `bbs-2023` cryptosuite for selective disclosure:

| Property | Value |
|----------|-------|
| Cryptosuite ID | `bbs-2023` |
| Curve | BLS12-381 G2 |
| Canonicalization | RDFC-2019 |
| Signature | BBS+ |
| Key format | Multikey (`zUC7...`) |

BBS+ enables holders to derive proofs that reveal only selected credential fields. See [Section 10](#10-selective-disclosure).

### 7.4 Bitcoin Attestation Suite: `bitcoin-ordinals-2024`

For Bitcoin witness attestations, implementations that support Bitcoin operations MUST support:

| Property | Value |
|----------|-------|
| Cryptosuite ID | `bitcoin-ordinals-2024` |
| Curve | secp256k1 |
| Hash | SHA-256 |
| Key format | Multikey (`zQ3c...`) |

### 7.5 Proof Hash Construction

When constructing the signed payload for Data Integrity proofs:

1. Canonicalize the document (without `proofValue`) using the suite's canonicalization algorithm.
2. Hash the canonicalized document with SHA-256, producing `documentHash` (32 bytes).
3. Canonicalize the proof options (without `proofValue`) using the suite's canonicalization algorithm.
4. Hash the canonicalized proof options with SHA-256, producing `proofConfigHash` (32 bytes).
5. Concatenate with domain separation: `PROOF_DOMAIN_TAG || proofConfigHash || documentHash`.
6. Sign the concatenated bytes.

Implementations MUST use a domain separation tag to prevent collision attacks between different (proofConfig, document) pairs. The RECOMMENDED domain separation tag is the UTF-8 encoding of the cryptosuite identifier.

> **Implementation note:** The SDK currently concatenates `proofConfigHash` and `documentHash` without domain separation. This is a known gap (see threat model F11) and will be addressed in a future SDK release.

---

## 8. Verification Algorithm

### 8.1 Seven-Step Verification

To verify a credential, implementations MUST perform the following steps:

**Step 1 — Structure validation.**
Verify the credential contains all required fields (`@context`, `type`, `issuer`, `credentialSubject`, `proof`). Verify `type` includes `"VerifiableCredential"`.

**Step 2 — Context validation.**
Verify `@context` includes the W3C credentials context (v1 or v2). Verify the Originals context is present for Originals-specific credential types.

**Step 3 — Issuer DID resolution.**
Resolve the `issuer` DID to obtain the issuer's DID Document. Verify the DID Document is not deactivated.

**Step 4 — Verification method resolution.**
Resolve `proof.verificationMethod` to a public key in the issuer's DID Document. Verify the key is listed under the declared `proofPurpose` (e.g., `assertionMethod`).

**Step 5 — Proof verification.**
Using the resolved public key and the cryptosuite algorithm declared in `proof.cryptosuite`:
1. Reconstruct the signed payload (document + proof options, minus `proofValue`).
2. Canonicalize using the cryptosuite's canonicalization algorithm.
3. Verify the `proofValue` signature against the canonicalized payload.

**Step 6 — Issuer-satoshi control verification (for `did:btco` issuers).**
If the issuer is a `did:btco` DID, verify that the issuer controls the satoshi referenced in their DID. This is confirmed by the inscription existing on the declared satoshi.

**Step 7 — Type-specific validation.**
Apply any type-specific validation rules:
- For `ResourceMetadataCredential`: Verify the referenced resource exists at the declared DID URL.
- For `OwnershipTransferred`: Verify the `txid` is a confirmed Bitcoin transaction.
- For `MigrationCompleted`: Verify both `sourceDid` and `targetDid` are resolvable.

### 8.2 Multi-Proof Credentials

When a credential contains multiple proofs (as an array), implementations MUST verify **all** proofs. A credential is valid only if every proof passes verification.

> **Implementation note:** The SDK currently verifies only the first proof in a multi-proof credential. This is a known limitation that will be addressed in a future release. Implementations SHOULD verify all proofs.

### 8.3 Verification Result

The verification result MUST include:

| Field | Type | Description |
|-------|------|-------------|
| `verified` | boolean | `true` if all checks pass. |
| `errors` | `string[]` | List of verification errors, if any. |
| `checks` | object | Individual check results (structure, context, issuer, proof, status). |

---

## 9. Status Mechanism

### 9.1 W3C Bitstring Status List

Credential status MUST use the [W3C Bitstring Status List](https://www.w3.org/TR/vc-bitstring-status-list/) mechanism. The legacy `BTCOStatusList2023` identifier is deprecated in favor of the W3C standard.

### 9.2 Status Entry

A credential with status includes:

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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | MUST be `"BitstringStatusListEntry"`. |
| `statusPurpose` | string | Yes | `"revocation"` or `"suspension"`. |
| `statusListIndex` | string | Yes | Bit position in the status list. |
| `statusListCredential` | string | Yes | URL of the status list credential. |

### 9.3 Status List Credential

The status list itself is a Verifiable Credential containing a GZIP-compressed, base64-encoded bitstring:

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
    "encodedList": "H4sIAAAAAAAA/2NgGAWjYBSMglEwCkYBhQAAAP//AAAA//8DAA..."
  },
  "proof": { ... }
}
```

### 9.4 Status Check

To check a credential's status:

1. Fetch the `statusListCredential` URL.
2. Verify the status list credential's proof.
3. Decode the `encodedList`: base64-decode, then GZIP-decompress.
4. Check the bit at position `statusListIndex`.
5. If the bit is `1`, the credential is revoked (or suspended, per `statusPurpose`).

### 9.5 Revocation vs. Suspension

| Purpose | Meaning | Reversible |
|---------|---------|-----------|
| `revocation` | The credential is permanently invalid. | No |
| `suspension` | The credential is temporarily invalid. | Yes — the bit can be flipped back to `0`. |

### 9.6 Backward Compatibility

The legacy `BTCOStatusList2023` type identifier is DEPRECATED. Implementations MUST support `BitstringStatusListEntry` and SHOULD accept `BTCOStatusList2023` as an alias during the transition period.

---

## 10. Selective Disclosure

### 10.1 BBS+ Selective Disclosure

Credentials signed with the `bbs-2023` cryptosuite support selective disclosure:

1. **Issuer** signs the full credential using BBS+.
2. **Holder** creates a derived proof revealing only selected fields.
3. **Verifier** validates the derived proof without learning undisclosed fields.

### 10.2 Derived Proof

A derived proof contains:

```json
{
  "type": "DataIntegrityProof",
  "cryptosuite": "bbs-2023",
  "created": "2026-03-01T12:00:00Z",
  "verificationMethod": "did:btco:1234567890#key-bbs",
  "proofPurpose": "assertionMethod",
  "proofValue": "z5ABCD..."
}
```

The `proofValue` in a derived proof is a zero-knowledge proof that the disclosed fields were part of a credential signed by the issuer, without revealing the other fields.

### 10.3 Use Cases

- **Privacy-preserving collectible verification:** Prove ownership of a collectible without revealing the full metadata.
- **Selective resource disclosure:** Prove a resource exists and has a certain type without revealing its content hash.
- **Creator verification:** Prove a DID created a resource without revealing when or what else they created.

---

## 11. Security Considerations

### 11.1 Proof Integrity

- Credentials MUST be signed with Data Integrity proofs. JWT-encoded credentials MUST NOT be used.
- Implementations MUST verify proofs before trusting any credential claims.
- Implementations MUST resolve issuer DIDs and verify the signing key is authorized for the declared `proofPurpose`.

### 11.2 Domain Separation

Proof hash construction (Section 7.5) MUST use domain separation to prevent collision attacks. Without domain separation, different (proofConfig, document) pairs could theoretically produce the same concatenated hash input.

### 11.3 External Signer Validation

When using external signers (HSMs, KMS), implementations SHOULD verify the returned `proofValue` is a valid signature before embedding it in the credential. A compromised external signer could return arbitrary proof values.

### 11.4 Context Injection

Malicious contexts could redefine credential terms. Implementations MUST use a static context loader (hardcoded context map) rather than fetching arbitrary URLs. This eliminates SSRF risk from JSON-LD context resolution.

### 11.5 Status List Availability

If a status list credential is unavailable (network error, server down), verifiers MUST NOT silently treat the credential as valid. Verifiers SHOULD:
- Cache the last-known status list with a configurable TTL.
- Reject credentials whose status cannot be checked, unless the verifier's policy explicitly allows it.

### 11.6 Credential Expiry

Verifiers MUST check `validFrom` and `validUntil` timestamps. A credential MUST be rejected if:
- The current time is before `validFrom`.
- The current time is after `validUntil` (if set).

### 11.7 Multi-Proof Security

Implementations MUST verify all proofs on a multi-proof credential. Accepting a credential after verifying only the first proof could allow an attacker to append a valid proof to a credential with an invalid second proof.

---

## 12. Conformance

A conformant implementation MUST:

1. Produce credentials with the W3C VC Data Model 2.0 context (`https://www.w3.org/ns/credentials/v2`).
2. Include the Ordinals context (`https://ordinals.plus/v1`) for Originals-specific credential types.
3. Support at least one of: `eddsa-jcs-2022` or `eddsa-rdfc-2022` for signing.
4. Verify all proofs on multi-proof credentials.
5. Implement the seven-step verification algorithm (Section 8.1).
6. Use `BitstringStatusListEntry` for credential status.
7. Use Multikey encoding for all keys (never JWK).
8. Use Data Integrity proofs (never JWT).

A conformant implementation SHOULD:

1. Support both `eddsa-jcs-2022` and `eddsa-rdfc-2022`.
2. Support the inscription metadata credential types (Section 4).
3. Support the lifecycle event credential types (Section 5).
4. Support credential chaining (Section 6).
5. Support BBS+ selective disclosure (Section 10).
6. Use domain separation in proof hash construction (Section 7.5).

---

## 13. References

### Normative References

- [W3C Verifiable Credentials Data Model v2.0](https://www.w3.org/TR/vc-data-model-2.0/) — Core credential data model.
- [W3C Data Integrity](https://www.w3.org/TR/vc-data-integrity/) — Cryptographic proof specification.
- [W3C Bitstring Status List](https://www.w3.org/TR/vc-bitstring-status-list/) — Credential status mechanism.
- [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119) — Key words for use in RFCs.
- [RFC 8785](https://datatracker.ietf.org/doc/html/rfc8785) — JSON Canonicalization Scheme (JCS).
- [Multibase](https://www.w3.org/TR/controller-document/#multibase) — Self-identifying base encodings.

### Informative References

- [BTCO DID Method](./btco-did-method-v1.md) — The `did:btco` DID method specification.
- [BTCO DID Linked Resources](./btco-did-linked-resources-v1.md) — Resource addressing for `did:btco`.
- [Originals Protocol Specification](./originals-protocol-v1.md) — Parent protocol specification.
- [EdDSA Cryptosuite v2022](https://www.w3.org/TR/vc-di-eddsa/) — EdDSA Data Integrity cryptosuites.
- [BBS Cryptosuite v2023](https://www.w3.org/TR/vc-di-bbs/) — BBS+ Data Integrity cryptosuite.
