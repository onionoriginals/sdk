# Gap Analysis: DIF Specs (v0.2.0) vs SDK Implementation

**Date:** 2026-03-12
**SDK Version:** @originals/sdk v1.9.0
**DIF Spec Version:** v0.2.0 (Draft)
**Specs Analyzed:**

1. [BTCO DID Method](https://identity.foundation/labs-ordinals-plus/btco-did-method)
2. [BTCO DID Linked Resources](https://identity.foundation/labs-ordinals-plus/btco-did-linked-resources)
3. [BTCO Verifiable Metadata](https://identity.foundation/labs-ordinals-plus/btco-vm)

---

## Summary


| Area                      | SDK-ahead (spec needs update) | Spec-ahead (SDK needs work) | Breaking changes |
| ------------------------- | ----------------------------- | --------------------------- | ---------------- |
| BTCO DID Method           | 4                             | 6                           | 2                |
| BTCO DID Linked Resources | 3                             | 7                           | 1                |
| BTCO Verifiable Metadata  | 3                             | 5                           | 1                |


---

## 1. BTCO DID Method

**Spec:** `did:btco:<sat-number>` (numerical ordinal only, per v0.2.0 breaking change)
**SDK files:** `BtcoDidResolver.ts`, `BitcoinManager.ts`, `DIDManager.ts`

### 1.1 Features in SDK not yet in spec (spec needs updating)


| #   | Feature                                                                | SDK Location                        | Notes                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Network-prefixed DIDs** (`did:btco:reg:<sat>`, `did:btco:sig:<sat>`) | `BtcoDidResolver.ts:55-60`          | The SDK supports `reg` and `sig` network prefixes for regtest and signet. The DIF spec only defines `did:btco:<sat-number>` with no network prefix mechanism. The spec should define how non-mainnet DIDs are represented. |
| 2   | **WebVH-to-Bitcoin network mapping**                                   | `types/network.ts`, `DIDManager.ts` | The SDK maps WebVH networks (pichu/cleffa/magby) to Bitcoin networks (mainnet/signet/regtest) automatically. This deployment topology is SDK-specific but could be referenced in the spec's deployment guidance.           |
| 3   | **Circuit breaker for provider calls**                                 | `BitcoinManager.ts:42-54`           | The SDK wraps the OrdinalsProvider with a configurable circuit breaker. This is a resilience pattern the spec could recommend.                                                                                             |
| 4   | **Fee oracle abstraction**                                             | `BitcoinManager.ts:58-105`          | The SDK supports pluggable fee estimation (external oracle -> provider fallback -> caller-provided). The spec has no fee estimation guidance.                                                                              |


### 1.2 Spec requirements not yet in SDK (SDK needs updating)


| #   | Requirement                           | Spec Section         | Gap Description                                                                                                                                                                                                                                                       | Priority |
| --- | ------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | **CBOR metadata encoding**            | Create, Resolve      | Spec requires DID Documents be stored as **CBOR-encoded metadata** on inscriptions. The SDK's `BtcoDidResolver` reads inscription content as text and treats metadata as a separate JSON object (`provider.getMetadata()`). No CBOR encoding/decoding is implemented. | **High** |
| 2   | **Reinscription for updates**         | Update               | Spec defines DID Document updates via reinscription on the same satoshi. The SDK has no `updateBTCODID()` method — only initial inscription and transfer.                                                                                                             | **High** |
| 3   | **Deactivation via minimal document** | Deactivate           | Spec requires deactivation by inscribing a minimal document with `"deactivated": true` in CBOR metadata. The SDK uses a fire emoji (`🔥`) in content to detect deactivation (`BtcoDidResolver.ts:168`), which diverges from the spec.                                 | **High** |
| 4   | **X25519 key agreement support**      | Verification Methods | Spec lists X25519 (`z6LS` prefix) for key agreement. The SDK's `KeyManager` supports ES256K, Ed25519, and ES256 but not X25519.                                                                                                                                       | Medium   |
| 5   | **Resolution metadata fields**        | Resolve              | Spec requires `versionId`, `nextVersionId`, and `equivalentId` in resolution metadata. The SDK's `BtcoDidResolutionResult` returns `inscriptionId` and `network` but lacks these version tracking fields.                                                             | Medium   |
| 6   | **secp256k1 Multikey prefix**         | Verification Methods | Spec defines secp256k1 with `z6MW` prefix. The SDK uses ES256K for secp256k1 but the Multikey prefix alignment should be verified.                                                                                                                                    | Low      |


### 1.3 Breaking changes between v0.2.0 spec and SDK


| #   | Change                        | Impact                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Numerical-only DID format** | The spec v0.2.0 eliminates name-based and decimal identifiers, using only `did:btco:<sat-number>`. The SDK already uses numerical satoshi identifiers, so this is **aligned**. However, the SDK also supports network prefixes (`did:btco:reg:`, `did:btco:sig:`) which the spec does not recognize — these DIDs would be **invalid** per strict spec compliance. |
| 2   | **CBOR metadata requirement** | The spec requires CBOR-encoded DID Documents in inscription metadata. The SDK currently stores/reads DID Documents as JSON. Switching to CBOR is a **breaking wire format change** for any existing inscriptions.                                                                                                                                                 |


---

## 2. BTCO DID Linked Resources

**Spec:** Resource identification via `did:btco:<sat>/[index]`, collections, pagination
**SDK files:** `ResourceManager.ts`, `LifecycleManager.ts`

### 2.1 Features in SDK not yet in spec (spec needs updating)


| #   | Feature                                           | SDK Location                 | Notes                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Content-addressed versioning with hash chains** | `ResourceManager.ts:180-247` | The SDK uses `previousVersionHash` to chain resource versions via content hashes. The spec uses inscription ordering for versioning but doesn't define a hash-chain mechanism. This is a stronger integrity guarantee that the spec could adopt. |
| 2   | **Resource validation pipeline**                  | `ResourceManager.ts:352-441` | The SDK provides extensive resource validation (MIME type format, size limits, hash verification, version chain integrity). The spec has minimal validation requirements.                                                                        |
| 3   | **Resource type inference from MIME**             | `ResourceManager.ts:610-630` | The SDK infers resource types (image, audio, video, text, other) from MIME content types. The spec does not define a type taxonomy.                                                                                                              |


### 2.2 Spec requirements not yet in SDK (SDK needs updating)


| #   | Requirement                                                       | Spec Section            | Gap Description                                                                                                                                                                                                                                         | Priority |
| --- | ----------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | **DID-based resource addressing** (`did:btco:<sat>/[index]`)      | Resource Identification | The spec identifies resources by inscription index on a satoshi (e.g., `did:btco:12345/0`). The SDK uses UUID-based resource IDs internally and does not implement DID-path resource addressing.                                                        | **High** |
| 2   | **Heritage collections** (parent-child inscription relationships) | Collection Types        | The spec defines heritage collections via `/heritage` and `/child/[index]` paths. The SDK has no concept of parent-child inscription relationships.                                                                                                     | **High** |
| 3   | **Controller collections** (wallet-address-based grouping)        | Collection Types        | The spec defines controller collections grouped by wallet address control. The SDK has no wallet-based resource grouping.                                                                                                                               | Medium   |
| 4   | **Curated collections** (VC-based resource lists)                 | Collection Types        | The spec defines curated collections via Verifiable Credentials containing resource lists at `/0/meta`. The SDK does not implement this collection type.                                                                                                | Medium   |
| 5   | **Pagination** (`limit`, `cursor`, `order` parameters)            | Pagination              | The spec defines pagination with default 10 / max 100 items, cursor-based navigation. The SDK's `ResourceManager` has no pagination support — it returns all resources.                                                                                 | Medium   |
| 6   | `**/info` and `/meta` endpoints**                                 | Resource Parameters     | The spec defines structured metadata endpoints returning JSON. The SDK has no concept of resource metadata endpoints.                                                                                                                                   | Medium   |
| 7   | **JSON Canonicalization Scheme (RFC 8785)**                       | Canonicalization        | The spec requires JCS for cryptographic proof comparison. The SDK uses `canonicalizeDocument()` which appears to use JSON-LD RDF canonicalization, not JCS. These serve different purposes but the spec is explicit about JCS for resource comparisons. | Low      |


### 2.3 Breaking changes


| #   | Change                             | Impact                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Resource identification scheme** | The spec uses `did:btco:<sat>/[index]` while the SDK uses UUID-based IDs. Implementing spec-compliant addressing would require adding a DID-path resolution layer on top of the existing resource management. This is additive rather than breaking for existing SDK users, but spec compliance requires it. |


---

## 3. BTCO Verifiable Metadata

**Spec:** W3C VC Data Model 2.0, credential types, cryptosuites, status lists
**SDK files:** `CredentialManager.ts`, `cryptosuites/eddsa.ts`, `cryptosuites/bbs.ts`, `StatusListManager.ts`, `BitstringStatusList.ts`

### 3.1 Features in SDK not yet in spec (spec needs updating)


| #   | Feature                                                                                                     | SDK Location                                     | Notes                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Credential chaining** (`previousCredentialId`, `previousCredentialHash`)                                  | `CredentialManager.ts:746-790`                   | The SDK supports chaining credentials together via ID and hash references in `credentialSubject.previousCredential`. The spec does not define credential chaining semantics.                                                                             |
| 2   | **Credential factory methods** (ResourceCreated, ResourceUpdated, MigrationCompleted, OwnershipTransferred) | `CredentialManager.ts:529-732`                   | The SDK defines four lifecycle credential types with structured subjects. The spec defines different types (ResourceMetadata, Collection, VerifiableCollectible, CuratedCollection). These are complementary but divergent.                              |
| 3   | **W3C BitstringStatusList** implementation                                                                  | `StatusListManager.ts`, `BitstringStatusList.ts` | The SDK implements the full W3C Bitstring Status List spec with gzip compression, batch operations, and both revocation and suspension. The DIF spec references `BTCOStatusList2023` which appears to be a different (or earlier) status list mechanism. |


### 3.2 Spec requirements not yet in SDK (SDK needs updating)


| #   | Requirement                                     | Spec Section      | Gap Description                                                                                                                                                                                                                                                                                                                                                                         | Priority |
| --- | ----------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | **W3C VC Data Model 2.0 alignment**             | Base Structure    | The spec requires `@context` to include W3C credentials v2 (`https://www.w3.org/ns/credentials/v2`) and Ordinals Plus context (`https://ordinals.plus/v1`). The SDK uses the older v1 context (`https://www.w3.org/2018/credentials/v1`) in `createResourceCredential()` and the v2 context only in `createCredentialWithChain()`. The `ordinals.plus/v1` context is not used anywhere. | **High** |
| 2   | **Spec-defined credential types**               | Credential Types  | The spec defines: ResourceMetadataCredential, CollectionCredential, VerifiableCollectibleCredential, CuratedCollectionCredential. The SDK defines: ResourceCreated, ResourceUpdated, MigrationCompleted, OwnershipTransferred. These are **different type taxonomies**. The SDK should implement the spec's types or the spec should adopt the SDK's types.                             | **High** |
| 3   | `**eddsa-jcs-2022` as recommended cryptosuite** | Cryptosuites      | The spec recommends `eddsa-jcs-2022` (JCS canonicalization). The SDK's EdDSA cryptosuite implements `eddsa-rdfc-2022` (RDF canonicalization). Both are valid Data Integrity suites but the spec explicitly recommends JCS.                                                                                                                                                              | Medium   |
| 4   | **7-step verification algorithm**               | Verification      | The spec defines a detailed 7-step verification process including: issuer DID resolution, issuer-satoshi control verification, referenced DID validation, and type-specific rules. The SDK's `verifyCredential()` focuses on signature verification but does not verify issuer-satoshi control or perform type-specific validation.                                                     | Medium   |
| 5   | `**BTCOStatusList2023` status type**            | Status/Revocation | The spec references `BTCOStatusList2023` as the status mechanism. The SDK implements `BitstringStatusListEntry` (W3C standard). These need alignment — either the spec should adopt the W3C standard or the SDK should support both.                                                                                                                                                    | Medium   |


### 3.3 Breaking changes


| #   | Change                      | Impact                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Credential context URLs** | The spec requires `https://www.w3.org/ns/credentials/v2` + `https://ordinals.plus/v1`. The SDK currently mixes v1 and v2 W3C contexts and does not include the Ordinals Plus context. Updating contexts would change credential serialization and potentially break verification of previously-issued credentials. |


---

## 4. Cross-cutting Gaps

### 4.1 Encoding: CBOR vs JSON

The DIF specs consistently use CBOR for on-chain data encoding (DID Documents, metadata). The SDK exclusively uses JSON. This is the single largest architectural gap and affects all three specs.

**Recommendation:** Add CBOR encoding/decoding support to the SDK. This could be implemented as a codec layer that serializes to CBOR for inscription and deserializes from CBOR for resolution, while keeping JSON as the internal representation.

### 4.2 DID-path resource addressing

The DIF specs use `did:btco:<sat>/[index]` for resource addressing with structured path segments (`/heritage`, `/controller`, `/info`, `/meta`). The SDK uses opaque UUIDs. Bridging this requires a DID-path resolver that maps spec paths to SDK resource lookups.

### 4.3 Context URL: `ordinals.plus/v1`

The DIF specs reference `https://ordinals.plus/v1` as a shared JSON-LD context. The SDK uses its own network-specific contexts (`https://pichu.originals.build/context`, etc.). These need to be reconciled — either the SDK should support both, or the specs should acknowledge the network-specific contexts.

### 4.4 Credential type taxonomy

The DIF spec and SDK define different credential type sets:


| DIF Spec Types                  | SDK Types            |
| ------------------------------- | -------------------- |
| ResourceMetadataCredential      | ResourceCreated      |
| CollectionCredential            | ResourceUpdated      |
| VerifiableCollectibleCredential | MigrationCompleted   |
| CuratedCollectionCredential     | OwnershipTransferred |


These serve different purposes. The spec types describe inscription properties; the SDK types describe lifecycle events. Both are needed. **Recommendation:** The SDK should implement the spec's types in addition to its existing lifecycle types, and the spec should acknowledge lifecycle credentials.

---

## 5. Priority Matrix

### Must fix for spec compliance (High)

1. **CBOR metadata encoding** — Required for valid `did:btco` creation and resolution
2. **DID Document update via reinscription** — No update path currently exists
3. **Deactivation protocol** — Fire emoji detection must be replaced with spec-compliant deactivation
4. **DID-path resource addressing** — Foundation of the linked resources spec
5. **W3C VC Data Model 2.0 context** — Credential interoperability
6. **Spec-defined credential types** — Type system alignment

### Should fix (Medium)

1. X25519 key agreement support
2. Resolution metadata version tracking fields
3. Heritage, controller, and curated collections
4. Collection pagination
5. `eddsa-jcs-2022` cryptosuite support
6. 7-step verification algorithm
7. Status list type alignment (`BTCOStatusList2023` vs `BitstringStatusListEntry`)
8. Resource metadata endpoints (`/info`, `/meta`)

### Nice to have (Low)

1. secp256k1 Multikey prefix verification
2. JCS canonicalization for resource comparisons

---

## 6. Spec-side recommendations

The following SDK features should be considered for inclusion in future spec revisions:

1. **Network-prefixed DIDs** — The SDK's `did:btco:reg:` and `did:btco:sig:` pattern is practical for multi-network development. The spec should define a network prefix mechanism.
2. **Content-addressed resource versioning** — Hash chains provide stronger integrity guarantees than inscription ordering alone.
3. **Credential chaining** — Linking credentials via hash references enables verifiable provenance chains.
4. **W3C BitstringStatusList** — The W3C standard is more mature than `BTCOStatusList2023` and should be the recommended mechanism.
5. **Lifecycle credential types** — ResourceCreated, MigrationCompleted, and OwnershipTransferred capture important lifecycle events that the spec's type system does not cover.

