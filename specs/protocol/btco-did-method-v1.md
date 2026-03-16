# BTCO DID Method Specification

**Version:** 1.0.0
**Status:** Draft
**Date:** March 2026
**Editors:** Originals Protocol Team
**Latest Draft:** [https://identity.foundation/labs-ordinals-plus/btco-did-method](https://identity.foundation/labs-ordinals-plus/btco-did-method)
**SDK Compatibility:** @originals/sdk v1.9.0+

---

## Abstract

This specification defines the `did:btco` DID method, which binds Decentralized Identifiers to Bitcoin Ordinals inscriptions. A `did:btco` identifier is anchored to a specific satoshi on the Bitcoin blockchain, and its DID Document is stored as CBOR-encoded metadata within an Ordinals inscription on that satoshi. Ownership of the DID is determined by control of the UTXO containing the inscribed satoshi.

---

## Status of This Document

This is a draft specification produced by the Originals Protocol project in collaboration with the Decentralized Identity Foundation (DIF). It is intended for review and implementation feedback.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [DID Method Syntax](#3-did-method-syntax)
4. [DID Document](#4-did-document)
5. [Operations](#5-operations)
6. [Resolution](#6-resolution)
7. [Key Encoding](#7-key-encoding)
8. [Network Deployments](#8-network-deployments)
9. [Fee Estimation](#9-fee-estimation)
10. [Security Considerations](#10-security-considerations)
11. [Privacy Considerations](#11-privacy-considerations)
12. [Conformance](#12-conformance)
13. [References](#13-references)

---

## 1. Introduction

### 1.1 Purpose

The `did:btco` method provides permanent, transferable decentralized identifiers backed by Bitcoin's proof-of-work security model. By inscribing DID Documents as Ordinals on specific satoshis, identifiers inherit Bitcoin's immutability and censorship resistance. Ownership is determined by whoever controls the UTXO containing the inscribed satoshi, enabling trustless transfer of identity without a central registry.

### 1.2 Design Goals

1. **Permanence.** Once inscribed, the DID Document is part of Bitcoin's permanent record.
2. **Transferability.** DID ownership transfers via standard Bitcoin transactions.
3. **Self-sovereignty.** No authority can revoke or alter an inscribed DID.
4. **Interoperability.** Compliant with W3C DID Core and resolvable by any Ordinals-aware resolver.
5. **Multi-network support.** Usable on mainnet, signet, and regtest for production, staging, and development respectively.

### 1.3 Relationship to Ordinals

This method depends on the [Ordinals protocol](https://docs.ordinals.com/), which assigns identity to individual satoshis and enables arbitrary data inscription. A `did:btco` identifier references a satoshi by its ordinal number, and the DID Document is stored in the inscription metadata on that satoshi.

---

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

| Term | Definition |
|------|-----------|
| **Satoshi** | The smallest unit of Bitcoin (1 BTC = 100,000,000 satoshis). Each satoshi has a unique ordinal number. |
| **Ordinal number** | A sequential number assigned to every satoshi in the order it was mined, per the Ordinals protocol. |
| **Inscription** | Arbitrary data attached to a specific satoshi via a Bitcoin transaction. |
| **CBOR** | Concise Binary Object Representation ([RFC 8949](https://datatracker.ietf.org/doc/html/rfc8949)). |
| **Reinscription** | A subsequent inscription on a satoshi that already carries one or more inscriptions. |
| **Controller** | The entity that controls the UTXO containing the inscribed satoshi. |
| **Commit-reveal** | A two-phase transaction pattern that protects against inscription front-running. |

---

## 3. DID Method Syntax

### 3.1 Method Name

The method name is `btco`.

### 3.2 Method-Specific Identifier

The `did:btco` identifier follows this ABNF:

```abnf
btco-did       = "did:btco:" [ network-prefix ":" ] sat-number
network-prefix = "sig" / "reg"
sat-number     = 1*DIGIT
```

**Mainnet** (default — no prefix):
```
did:btco:1234567890
```

**Signet** (test network):
```
did:btco:sig:1234567890
```

**Regtest** (local development):
```
did:btco:reg:1234567890
```

### 3.3 Satoshi Number Constraints

The satoshi number MUST satisfy:

- It MUST be a non-negative integer.
- It MUST be less than or equal to 2,099,999,997,690,000 (the total number of satoshis that will ever exist).
- It MUST NOT contain leading zeros.
- It MUST be represented as a decimal string.

### 3.4 DID URL Syntax

DID URLs extend the base DID with optional path, query, and fragment components:

```abnf
btco-did-url = btco-did [ "/" path ] [ "?" query ] [ "#" fragment ]
path         = 1*( "/" segment )
segment      = *pchar
```

Path segments are used for resource addressing (see [BTCO DID Linked Resources](./btco-did-linked-resources-v1.md)).

**Examples:**
```
did:btco:1234567890/0              — First resource on this satoshi
did:btco:1234567890/heritage       — Heritage collection
did:btco:1234567890#key-0          — Verification method fragment
did:btco:sig:9876543210/0/info     — Resource info on signet
```

---

## 4. DID Document

### 4.1 Structure

A `did:btco` DID Document MUST conform to [W3C DID Core](https://www.w3.org/TR/did-core/) and MUST include:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1",
    "https://w3id.org/security/data-integrity/v2"
  ],
  "id": "did:btco:1234567890",
  "controller": "did:btco:1234567890",
  "verificationMethod": [
    {
      "id": "did:btco:1234567890#key-0",
      "type": "Multikey",
      "controller": "did:btco:1234567890",
      "publicKeyMultibase": "z6Mk..."
    }
  ],
  "authentication": ["did:btco:1234567890#key-0"],
  "assertionMethod": ["did:btco:1234567890#key-0"]
}
```

### 4.2 Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `@context` | `string[]` | MUST include `https://www.w3.org/ns/did/v1`. SHOULD include multikey and data-integrity contexts. |
| `id` | string | MUST match the `did:btco` identifier for this satoshi. |
| `controller` | string | MUST be a valid DID. Typically the DID itself. |
| `verificationMethod` | array | MUST contain at least one Multikey verification method. |
| `authentication` | array | MUST reference at least one verification method. |
| `assertionMethod` | array | SHOULD reference at least one verification method for credential signing. |

### 4.3 Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `service` | array | Service endpoints associated with this DID. |
| `keyAgreement` | array | Verification methods for key agreement (e.g., X25519). |
| `capabilityInvocation` | array | Verification methods for capability invocations. |
| `capabilityDelegation` | array | Verification methods for capability delegations. |
| `alsoKnownAs` | `string[]` | Alternative identifiers. MAY include the source `did:peer` or `did:webvh` from migration. |

### 4.4 Verification Method Types

Implementations MUST support the following Multikey types:

| Key Type | Multikey Prefix | Use Case |
|----------|-----------------|----------|
| Ed25519 | `z6Mk` | Credential signing, DID operations |
| secp256k1 | `z6MW` | Bitcoin operations |

Implementations SHOULD support:

| Key Type | Multikey Prefix | Use Case |
|----------|-----------------|----------|
| X25519 | `z6LS` | Key agreement |
| P-256 | `zDn` | General cryptography |

### 4.5 Encoding

DID Documents MUST be stored as CBOR-encoded metadata ([RFC 8949](https://datatracker.ietf.org/doc/html/rfc8949)) in the inscription. The inscription content MUST contain the DID identifier as a text string (e.g., `did:btco:1234567890`), and the full DID Document MUST be stored in the inscription's CBOR metadata field.

Resolvers MUST:
1. Read the inscription content to extract the DID identifier.
2. Read the CBOR metadata to extract the DID Document.
3. Decode the CBOR metadata into a JSON DID Document for consumption.

> **Implementation note:** The SDK currently stores DID Documents as JSON metadata rather than CBOR. CBOR encoding support is planned. Implementations SHOULD support both CBOR and JSON metadata during the transition period, preferring CBOR when available.

---

## 5. Operations

### 5.1 Create

To create a `did:btco` DID:

1. Generate a key pair of a supported type (see [Section 7](#7-key-encoding)).
2. Construct a DID Document with the satoshi number as the method-specific identifier.
3. Encode the DID Document as CBOR metadata.
4. Inscribe on the target satoshi using the commit-reveal pattern (see [Section 5.5](#55-commit-reveal-pattern)).

**Preconditions:**
- The target satoshi MUST NOT already carry a valid `did:btco` inscription (unless intentionally reinscribing for an update).
- The creator MUST control the UTXO containing the target satoshi.

**Postconditions:**
- The inscription is confirmed on the Bitcoin blockchain.
- The DID is resolvable by any conformant resolver.

### 5.2 Read (Resolve)

See [Section 6](#6-resolution).

### 5.3 Update

To update a `did:btco` DID Document:

1. Construct the updated DID Document with the same `id`.
2. Encode the updated document as CBOR metadata.
3. Reinscribe on the same satoshi using the commit-reveal pattern.

The resolver MUST treat the **latest valid inscription** on the satoshi as the current DID Document. Older inscriptions represent prior versions.

**Constraints:**
- The updater MUST control the UTXO containing the inscribed satoshi.
- The updated document MUST retain the same `id` as the original.
- Implementations SHOULD include a `versionId` in the resolution metadata to track document versions.

### 5.4 Deactivate

To deactivate a `did:btco` DID:

1. Construct a minimal DID Document containing only the required fields and the `deactivated` property set to `true`.
2. Encode as CBOR metadata with `"deactivated": true`.
3. Reinscribe on the same satoshi.

**Minimal deactivation document:**

```json
{
  "@context": "https://www.w3.org/ns/did/v1",
  "id": "did:btco:1234567890",
  "deactivated": true
}
```

The resolver MUST check for the `deactivated` property in CBOR metadata. When `deactivated` is `true`, the resolver MUST return the DID Document with `deactivated: true` in the document metadata and MUST NOT use the DID's verification methods for any cryptographic operations.

> **Implementation note:** The SDK currently detects deactivation via a fire emoji (`🔥`) in inscription content. This is a legacy behavior that will be replaced by the CBOR `deactivated` flag. During the transition, resolvers SHOULD check both mechanisms.

### 5.5 Commit-Reveal Pattern

All inscription operations (create, update, deactivate) MUST use a two-phase commit-reveal pattern to prevent front-running:

**Phase 1 — Commit:**
1. Generate a random key pair for the reveal transaction.
2. Create a commit transaction that locks the target satoshi to the reveal key.
3. Broadcast the commit transaction and wait for confirmation.

**Phase 2 — Reveal:**
1. Create a reveal transaction spending the commit output.
2. Include the inscription data (content + CBOR metadata) in the reveal transaction.
3. Broadcast the reveal transaction.

**Security rationale:** Without commit-reveal, a miner or mempool observer could observe the DID Document data and inscribe it on a different satoshi first. The commit phase binds a specific satoshi before the document content is revealed.

### 5.6 Transfer

To transfer ownership of a `did:btco` DID:

1. Create a Bitcoin transaction that moves the inscribed satoshi to the recipient's address.
2. Optionally reinscribe an updated DID Document reflecting the new controller.
3. Record the transfer in the asset's Canonical Event Log (if applicable).

**Preconditions:**
- The sender MUST control the UTXO containing the inscribed satoshi.
- The recipient address MUST be a valid Bitcoin address for the target network.

**Postconditions:**
- The recipient controls the UTXO containing the inscribed satoshi.
- The DID resolves to the same (or updated) document, now under the recipient's control.

---

## 6. Resolution

### 6.1 Resolution Algorithm

To resolve a `did:btco` identifier:

1. Parse the DID to extract the network prefix (if any) and satoshi number.
2. Query an Ordinals indexer for all inscriptions on the specified satoshi.
3. For each inscription (from newest to oldest):
   a. Fetch the inscription content.
   b. Verify the content contains the expected DID identifier.
   c. Fetch the inscription metadata.
   d. Decode the metadata (CBOR or JSON) as a DID Document.
   e. Validate the DID Document structure (see [Section 6.3](#63-document-validation)).
   f. Check for deactivation (`deactivated: true` in metadata, or legacy `🔥` in content).
4. Return the DID Document from the latest valid, non-deactivated inscription.
5. If no valid inscription is found, return an error.

### 6.2 Resolution Result

The resolution result MUST conform to [DID Resolution](https://w3c-ccg.github.io/did-resolution/) and include:

```json
{
  "didDocument": { ... },
  "didResolutionMetadata": {
    "contentType": "application/did+json",
    "inscriptionId": "abc123i0",
    "satNumber": "1234567890",
    "network": "mainnet",
    "totalInscriptions": 3
  },
  "didDocumentMetadata": {
    "created": "2026-01-15T10:00:00Z",
    "updated": "2026-02-20T14:30:00Z",
    "deactivated": false,
    "versionId": "abc123i2",
    "nextVersionId": null,
    "equivalentId": ["did:btco:1234567890"],
    "inscriptionId": "abc123i2",
    "network": "mainnet"
  }
}
```

**Resolution metadata fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `contentType` | string | Yes | MUST be `application/did+json`. |
| `inscriptionId` | string | Yes | The Ordinals inscription ID of the resolved document. |
| `satNumber` | string | Yes | The satoshi number. |
| `network` | string | Yes | `mainnet`, `signet`, or `regtest`. |
| `totalInscriptions` | number | Yes | Total inscriptions on this satoshi. |

**Document metadata fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `created` | string | SHOULD | RFC 3339 timestamp of the first inscription. |
| `updated` | string | SHOULD | RFC 3339 timestamp of the latest inscription. |
| `deactivated` | boolean | Yes | `true` if the DID has been deactivated. |
| `versionId` | string | SHOULD | Inscription ID of the current version. |
| `nextVersionId` | string | MAY | Inscription ID of the next version (if known). |
| `equivalentId` | `string[]` | MAY | Equivalent DID identifiers (e.g., with/without network prefix). |
| `inscriptionId` | string | Yes | Inscription ID of the resolved document. |
| `network` | string | Yes | Bitcoin network. |

### 6.3 Document Validation

A resolver MUST validate:

1. The document contains `@context` including `https://www.w3.org/ns/did/v1` or `https://w3id.org/did/v1`.
2. The `id` field matches the expected `did:btco` identifier for this satoshi and network.
3. The `verificationMethod` field, if present, is an array.
4. The `authentication` field, if present, is an array.

A resolver SHOULD reject documents that:
- Contain `id` values that do not match the satoshi being queried.
- Reference verification methods not present in the document.

### 6.4 Error Codes

| Error | Meaning |
|-------|---------|
| `invalidDid` | The DID string does not conform to `did:btco` syntax. |
| `notFound` | No valid inscriptions found on the specified satoshi. |
| `noProvider` | No Ordinals provider was supplied for resolution. |
| `deactivated` | The DID has been deactivated. |

---

## 7. Key Encoding

### 7.1 Multikey Format

All public keys in `did:btco` DID Documents MUST use Multikey encoding. JSON Web Key (JWK) format MUST NOT be used.

**Encoding:** `z` + base58btc(multicodec_prefix + raw_key_bytes)

| Key Type | Multicodec Prefix | Example Prefix | Key Length |
|----------|-------------------|----------------|------------|
| Ed25519 public | `0xed01` | `z6Mk...` | 32 bytes |
| Ed25519 private | `0x8026` | `z3u2...` | 32 bytes |
| secp256k1 public (compressed) | `0xe701` | `zQ3c...` | 33 bytes |
| secp256k1 private | `0x1301` | `z42t...` | 32 bytes |
| P-256 public (compressed) | `0x1200` | `zDn...` | 33 bytes |
| X25519 public | `0xec01` | `z6LS...` | 32 bytes |

### 7.2 Verification Method Encoding

Verification methods in the DID Document MUST use the `Multikey` type:

```json
{
  "id": "did:btco:1234567890#key-0",
  "type": "Multikey",
  "controller": "did:btco:1234567890",
  "publicKeyMultibase": "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
}
```

---

## 8. Network Deployments

### 8.1 Network Tiers

The `did:btco` method operates across three Bitcoin network tiers:

| Network | DID Prefix | Bitcoin Network | Use Case |
|---------|-----------|----------------|----------|
| Mainnet | `did:btco:` | mainnet | Production identifiers |
| Signet | `did:btco:sig:` | signet | Staging and testing |
| Regtest | `did:btco:reg:` | regtest | Local development |

### 8.2 WebVH Network Mapping

When `did:btco` identifiers are created via migration from `did:webvh`, the Bitcoin network is determined by the source WebVH network:

| WebVH Network | Domain | Bitcoin Network | DID Prefix |
|---------------|--------|----------------|-----------|
| pichu | `pichu.originals.build` | mainnet | `did:btco:` |
| cleffa | `cleffa.originals.build` | signet | `did:btco:sig:` |
| magby | `magby.originals.build` | regtest | `did:btco:reg:` |

Implementations MUST NOT allow cross-network migration (e.g., a `did:webvh` on `magby.originals.build` MUST NOT produce a mainnet `did:btco`).

### 8.3 Network Detection

Resolvers MUST determine the Bitcoin network from the DID:
- `did:btco:reg:*` → regtest
- `did:btco:sig:*` → signet
- `did:btco:*` (no prefix) → mainnet

---

## 9. Fee Estimation

### 9.1 Fee Priority Hierarchy

Implementations SHOULD support a tiered fee estimation strategy:

1. **Fee oracle** (highest priority): An external service providing real-time fee estimates. Implementations MAY support a pluggable `FeeOracleAdapter` interface.
2. **Provider estimation**: The Ordinals provider's built-in fee estimation.
3. **Caller-provided rate**: An explicit fee rate (in sat/vB) passed by the caller.

### 9.2 Fee Rate Bounds

Implementations MUST enforce fee rate bounds to prevent accidental fund loss:

- **Minimum:** 1.1 sat/vB (minimum relay fee).
- **Maximum:** 10,000 sat/vB (configurable).

Implementations SHOULD warn when the fee rate exceeds 500 sat/vB.

### 9.3 Dust Limit

All transaction outputs MUST meet the dust limit (546 satoshis). If a change output would be below the dust limit, the surplus MUST be added to the transaction fee rather than creating a dust output.

### 9.4 Circuit Breaker

Implementations SHOULD wrap Ordinals provider calls in a circuit breaker pattern to prevent cascade failures. The circuit breaker SHOULD:
- Open after a configurable number of consecutive failures (default: 5).
- Enter a half-open state after a configurable timeout (default: 30 seconds).
- Close after a successful call in the half-open state.

---

## 10. Security Considerations

### 10.1 Front-Running Protection

The commit-reveal pattern (Section 5.5) is the primary defense against front-running. Implementations MUST generate a fresh random key pair for each reveal transaction to prevent key reuse attacks.

### 10.2 UTXO Management

Implementations MUST use ordinal-aware UTXO selection:
- UTXOs containing inscribed satoshis MUST be flagged and excluded from fee-funding selection.
- Cardinal UTXOs (without inscriptions) SHOULD be preferred for fee payment.
- Implementations MUST NOT accidentally spend inscription-bearing UTXOs as fee inputs.

### 10.3 Provider Security

- Ordinals provider connections MUST use HTTPS in production. HTTP MAY be used for local regtest providers.
- Implementations SHOULD validate provider responses against expected schemas.
- Implementations SHOULD NOT trust provider responses for security-critical decisions without independent verification.

### 10.4 Inscription Content Validation

When resolving inscriptions, implementations MUST:
- Validate that the inscription content matches the expected DID identifier.
- Validate that the DID Document `id` matches the expected identifier.
- Reject inscriptions with mismatched identifiers.

Implementations SHOULD:
- Validate URL schemes in inscription content URLs (allow only `https://`).
- Reject URLs targeting private IP ranges or localhost to prevent SSRF attacks.

### 10.5 Key Security

- Private keys MUST NOT appear in log output or error messages.
- Private keys SHOULD be kept as `Uint8Array` and not converted to string representations unless absolutely necessary.
- When using external signers, implementations SHOULD verify the returned `proofValue` is a valid signature before accepting it.

### 10.6 Transaction Input Limits

Implementations SHOULD enforce a maximum number of transaction inputs (RECOMMENDED default: 100) to prevent constructing transactions that exceed node relay limits or incur excessive fees.

### 10.7 Inscription Size Limits

Implementations SHOULD enforce a maximum inscription data size (RECOMMENDED default: 4 MB) to prevent memory exhaustion during serialization.

### 10.8 Satoshi Number Validation

Before any operation, implementations MUST validate:
- The satoshi number is within Bitcoin's total supply range.
- Bitcoin addresses are valid for the target network (format and checksum).
- Fee rates are positive numbers within configured bounds.

---

## 11. Privacy Considerations

### 11.1 Public Blockchain

All `did:btco` operations are recorded on the Bitcoin blockchain and are publicly visible. Users SHOULD be aware that:

- DID Documents inscribed on Bitcoin are permanent and cannot be deleted.
- Transaction history reveals when a DID was created, updated, or transferred.
- UTXO analysis may reveal the controller's other Bitcoin holdings.

### 11.2 Correlation Risk

Multiple `did:btco` identifiers controlled by the same wallet are correlatable through blockchain analysis. Users requiring privacy SHOULD use separate wallets for separate identities.

### 11.3 Migration Provenance

When a `did:btco` is created by migrating from `did:peer` or `did:webvh`, the migration event links the identifiers. This is intentional (provenance is the goal) but users SHOULD understand that migration creates a permanent, public link between their private and public identifiers.

---

## 12. Conformance

A conformant `did:btco` implementation MUST:

1. Parse DID identifiers according to the syntax in Section 3.
2. Support mainnet identifiers (`did:btco:<sat-number>`).
3. Support network-prefixed identifiers (`did:btco:sig:`, `did:btco:reg:`).
4. Validate satoshi numbers per Section 3.3.
5. Store DID Documents as CBOR-encoded inscription metadata (or JSON during the transition period).
6. Use the commit-reveal pattern for all inscription operations.
7. Resolve DIDs by querying inscriptions on the specified satoshi.
8. Return the latest valid, non-deactivated DID Document.
9. Return conformant resolution metadata per Section 6.2.
10. Use Multikey encoding for all verification methods (never JWK).

A conformant implementation SHOULD:

1. Support the circuit breaker pattern for provider calls.
2. Support tiered fee estimation.
3. Enforce inscription size limits.
4. Enforce HTTPS for provider connections.

---

## 13. References

### Normative References

- [W3C DID Core](https://www.w3.org/TR/did-core/) — Decentralized Identifiers specification.
- [W3C DID Resolution](https://w3c-ccg.github.io/did-resolution/) — DID Resolution specification.
- [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119) — Key words for use in RFCs.
- [RFC 8949](https://datatracker.ietf.org/doc/html/rfc8949) — Concise Binary Object Representation (CBOR).
- [Multibase](https://www.w3.org/TR/controller-document/#multibase) — Self-identifying base encodings.
- [Multicodec](https://github.com/multiformats/multicodec) — Self-identifying codecs.

### Informative References

- [Ordinals Protocol](https://docs.ordinals.com/) — Bitcoin Ordinals documentation.
- [Originals Protocol Specification](./originals-protocol-v1.md) — Parent protocol specification.
- [BTCO DID Linked Resources](./btco-did-linked-resources-v1.md) — Resource addressing for `did:btco`.
- [BTCO Verifiable Metadata](./btco-verifiable-metadata-v1.md) — Credential types for `did:btco`.
