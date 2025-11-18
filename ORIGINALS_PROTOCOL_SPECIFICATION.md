# Originals Protocol v1.0 Specification

**Version:** 1.0-DRAFT
**Status:** Approved for Implementation
**Authors:** Originals Team
**Last Updated:** November 18, 2025
**Reference:** SDK Assessment at ORIGINALS_SDK_ASSESSMENT.md

---

## Table of Contents

1. [Specification Overview](#specification-overview)
2. [Core Concepts](#core-concepts)
3. [Architecture](#architecture)
4. [Migration Rules](#migration-rules)
5. [Credentials System](#credentials-system)
6. [Bitcoin Integration](#bitcoin-integration)
7. [Compliance & Validation](#compliance--validation)
8. [Error Handling](#error-handling)
9. [Performance Requirements](#performance-requirements)

---

## Specification Overview

**Title:** Originals Protocol v1.0 Specification

The **Originals Protocol** is a specification for managing digital assets through a three-layer decentralized identifier (DID) lifecycle, enabling progressive custody escalation from private creation to public discovery to blockchain-verified ownership.

---

## Core Concepts

### Definition

The Originals Protocol organizes digital asset lifecycles through three distinct layers, each with different security, cost, and functionality characteristics. Assets progress unidirectionally through these layers: private creation → public discovery → permanent blockchain ownership.

### Principles

1. **Unidirectional Progression**: Assets migrate from private → public → permanent, never backward
2. **Cryptographic Integrity**: All operations include verifiable proofs of ownership and provenance
3. **Economic Gravity**: Each layer has different cost/security tradeoffs (free/easy → $25/year → $75-200 one-time)
4. **W3C Compliance**: Uses standard DID and Verifiable Credential specifications
5. **Portability**: Assets carry full provenance history through migrations
6. **Privacy by Default**: Private layer requires no registration or disclosure

---

## Architecture

### Three-Layer Model

```
                         ┌──────────────────────┐
                         │   Bitcoin Network    │
                         │    (did:btco)        │
                         │  - Permanent         │
                         │  - Transferable      │
                         │  - Verifiable        │
                         │  - Cost: $75-200     │
                         └──────────────────────┘
                                   △
                                   │
                            Unidirectional
                            Migration Only
                                   │
                         ┌─────────┴──────────┐
                         │   Web Hosting      │
                         │  (did:webvh)       │
                         │  - Public          │
                         │  - Discoverable    │
                         │  - Versioned       │
                         │  - Cost: ~$25/yr   │
                         └─────────┬──────────┘
                                   △
                                   │
                            Unidirectional
                            Migration Only
                                   │
                         ┌─────────┴──────────┐
                         │  Private Creation  │
                         │   (did:peer)       │
                         │  - Offline         │
                         │  - Free            │
                         │  - Self-contained  │
                         └────────────────────┘
```

### DID Methods

#### did:peer (Private Layer)

**Format:** `did:peer:4z<multibase-encoded-long-form-did>`

**Characteristics:**
- Variant 4 long-form DID (includes full DID document)
- No network or registry required
- Self-verifiable (contains all necessary keys)
- Offline generation
- Portable (can be exported and imported)

**Lifetime:** Throughout asset lifecycle (source of truth for key material)

**Key Properties:**
- `did` - The DID identifier
- `@context` - JSON-LD context array
- `verificationMethod` - List of cryptographic keys
- `authentication` - Methods for proving control
- `assertionMethod` - Methods for signing credentials
- `keyAgreement` - Methods for key agreement (optional)
- `service` - External service endpoints (optional)

**Creation Rule:**
- MUST be created before publishing or inscribing
- MUST include at least one verification method
- MUST set authentication relationship
- MUST set assertionMethod for credential signing

**Validation:**
- Validate DID format (did:peer:4z...)
- Verify DID document structure against W3C spec
- Confirm keys are properly multibase-encoded
- Validate relationships reference valid verification methods

---

#### did:webvh (Public Discovery Layer)

**Format:** `did:webvh:<domain>:<optional-path>:<identifier>`

**Examples:**
- `did:webvh:example.com:alice` (at `/.well-known/did.jsonl` with path "alice")
- `did:webvh:example.com:orgs:acme:assets:nft-001` (nested path)

**Characteristics:**
- Publicly resolvable via HTTPS
- Version history (DID log in JSONL format)
- Key rotation with pre-rotation support
- Portable and cacheable
- W3C DID Document standard

**Hosting Requirement:**
- DID log hosted at `https://<domain>/.well-known/did.jsonl?path=<path>`
- Each line is a JSON version entry
- Supports HTTP caching headers
- Must be publicly accessible

**DID Log Format (JSONL):**
```
{versionId, versionTime, parameters, state, proof}
{versionId, versionTime, parameters, state, proof}
...
```

**Key Properties:**
- Inherits all properties from source did:peer
- `versionId` - Identifies this log entry
- `versionTime` - ISO timestamp of version
- `previousVersionId` - Link to previous entry (optional)

**Creation Rule:**
- MUST come from existing did:peer
- MUST specify domain and path for hosting
- MUST initialize DID log with genesis entry
- MUST set up HTTPS hosting before migration considered complete

**Update Rule:**
- MUST create new version log entry
- MUST link to previous version
- MUST be signed by authorized update key
- MUST increment version ID

**Validation:**
- Validate DID format
- Verify HTTPS hosting is accessible
- Check DID log is valid JSONL
- Validate each log entry has valid proof
- Confirm version chain is unbroken

---

#### did:btco (Permanent Bitcoin Layer)

**Format:** `did:btco:<satoshi-number>` (mainnet) or `did:btco:test:<satoshi>` (testnet) or `did:btco:sig:<satoshi>` (signet)

**Examples:**
- `did:btco:2099994098` (mainnet satoshi #2099994098)
- `did:btco:test:1000000` (testnet satoshi #1000000)
- `did:btco:sig:500000` (signet satoshi #500000)

**Characteristics:**
- Inscribed on Bitcoin blockchain
- Immutable once confirmed
- Unique satoshi identifier
- Permanent ownership record
- Transferable via Bitcoin transactions
- Network-specific identifiers

**Inscription Format:**
- DID document encoded as JSON
- Content-Type: `application/did+json`
- Inscribed via Ordinals protocol
- Witness script contains DID data

**Key Properties:**
- Inherits all properties from source did:peer or did:webvh
- `satoshi` - The unique satoshi number
- `txid` - Transaction ID for inscription
- `blockHeight` - Bitcoin block height of confirmation
- `confirmations` - Current confirmation count

**Creation Rule:**
- MUST come from existing did:peer or did:webvh
- MUST create Bitcoin Ordinals inscription
- MUST use commit-reveal pattern (two-phase)
- MUST wait for 1+ confirmation before considering final
- MUST store transaction ID in audit record

**Transfer Rule:**
- MUST use Bitcoin transaction to move satoshi
- MUST update DID document during transfer
- MUST preserve all key material and properties
- MUST maintain unbroken transaction chain

**Validation:**
- Validate DID format and satoshi number
- Verify inscription exists on Bitcoin
- Check DID document matches inscribed data
- Validate satoshi number matches blockchain state
- Confirm transaction history chain

---

### Asset Structure

**Definition:** An Original is a digital asset with cryptographically verifiable provenance.

**Properties:**

```typescript
interface Original {
  // Core identity
  id: string;                    // Stable asset ID
  layers: LayerRecord[];         // Migration history

  // Current state
  currentDID: string;            // Active DID
  currentLayer: LayerType;       // Which layer (peer/webvh/btco)

  // Asset content
  resources: AssetResource[];    // Versioned content
  metadata: Record<string, unknown>; // Custom metadata

  // Provenance & credentials
  credentials: VerifiableCredential[]; // Associated VCs
  provenance: ProvenanceChain;   // Complete history

  // Ownership & control
  owner: string;                 // Owner DID
  controller: string;            // Controller DID (may differ)
  signatures: Signature[];       // Proof of ownership
}

interface LayerRecord {
  layer: LayerType;
  did: string;
  createdAt: string;             // ISO timestamp
  transactionId?: string;        // For btco inscriptions
  satoshi?: string;              // For btco satoshi reference
  metadata?: Record<string, unknown>;
}

interface AssetResource {
  id: string;                    // Stable resource ID
  type: string;                  // MIME type category
  contentType: string;           // Full MIME type
  hash: string;                  // Content hash (SHA-256)
  size: number;                  // Bytes
  version: number;               // Version number
  createdAt: string;             // ISO timestamp
  previousVersionHash?: string;  // Link to prior version
  integrity?: IntegrityProof;    // Cryptographic proof
}

interface ProvenanceChain {
  createdAt: string;             // Creation timestamp
  creator: string;               // Creator DID
  creationProof: Signature;      // Signature by creator

  migrations: Migration[];       // Layer transitions
  transfers: Transfer[];         // Ownership transfers
  updates: Update[];             // Resource/metadata changes

  // Audit trail
  auditLog: AuditEntry[];        // All operations
}

interface Migration {
  from: LayerType;
  to: LayerType;
  timestamp: string;
  sourceDID: string;
  targetDID: string;
  transactionId?: string;        // For blockchain migrations
  satoshi?: string;              // For btco
  proof: Signature;              // Signed by asset owner
}

interface Transfer {
  from: string;                  // Previous owner DID
  to: string;                    // New owner DID
  timestamp: string;
  transactionId?: string;        // For blockchain transfers
  proof: Signature;              // Signed by previous owner
}

interface Update {
  resourceId: string;
  fromVersion: number;
  toVersion: number;
  changes: string[];             // Description of changes
  timestamp: string;
  proof: Signature;              // Signed by owner/controller
}
```

---

## Migration Rules

### Valid Migration Paths

```
✅ did:peer → did:webvh
✅ did:webvh → did:btco
✅ did:peer → did:btco (direct, skipping webvh)

❌ did:webvh → did:peer (backward)
❌ did:btco → did:webvh (backward)
❌ did:btco → did:peer (backward)
```

**Rationale:** Unidirectional progression increases security/permanence. Reverse migrations would break immutability guarantees.

### Migration Requirements

**Universal Requirements (All Migrations):**
1. Source DID must exist and be resolvable
2. Asset must not already be on target layer
3. All associated credentials must be re-issuable on target layer
4. Owner/controller must authorize migration
5. Signature from owner required
6. Complete migration history recorded in audit log

**did:peer → did:webvh Requirements:**
1. Web domain must be registered and accessible
2. HTTPS must be enabled (not HTTP)
3. `.well-known` directory must be writable
4. DID log must be publicly readable
5. Must be able to wait for DNS propagation
6. Estimated time: <1 second (network I/O excluded)
7. Cost: None (besides domain cost)

**webvh → did:btco Requirements:**
1. Bitcoin network must be accessible
2. Sufficient funds for inscription fee (estimated before migration)
3. Confirm user accepts estimated fee
4. Ordinals protocol support required (Taproot/P2TR)
5. Must be able to wait for Bitcoin confirmation (10+ minutes)
6. Estimated time: <10 minutes with 1 confirmation wait
7. Cost: $75-200 depending on fee rate and network congestion

**did:peer → did:btco (Direct) Requirements:**
1. All webvh requirements apply
2. Skips public layer, goes direct to Bitcoin
3. Same cost and time as webvh→btco migration
4. Use case: High-value original work for direct sale

### Migration Guarantees

**Atomicity:** Migrations are atomic - either complete or fully rolled back. No intermediate states.

**Data Preservation:** All data carried to new layer:
- DID document structure and keys
- All associated credentials
- Resource references (content hash, type, metadata)
- Complete provenance history
- Owner/controller information

**Proof Continuity:** Cryptographic proofs remain valid:
- Original creator proof intact
- Owner signature chain unbroken
- Credentials re-issued but validatable
- Bitcoin inscription includes migration metadata

**Audit Trail:** Every migration recorded with:
- Timestamp (ISO-8601)
- Source and target DIDs
- Owner authorization signature
- Transaction IDs (for blockchain migrations)
- Status (completed, failed, rolled back)

---

## Credentials System

### Credential Types

**1. Asset Ownership Credential**
- Issued at creation (did:peer creation)
- Asserts entity is official owner
- Re-issued at each layer migration
- Transferable via Bitcoin transaction

**2. Resource Integrity Credential**
- Issued for each resource/version
- Asserts hash and size
- Proves immutability of content
- Updated when resource is updated

**3. Provenance Credential**
- Issued at creation
- Documents asset history/lineage
- Updated at each significant event
- Enables provenance verification

**4. Domain Authority Credential** (did:webvh only)
- Issued by domain owner
- Asserts control of `.well-known` path
- Enables DID log authenticity
- Updated on domain transfer

### Credential Requirements

**All credentials MUST:**
1. Be W3C Verifiable Credential v2.0 compliant
2. Use JSON-LD format (not JWT)
3. Include Data Integrity proofs
4. Reference issuer's DID
5. Be re-issuable on target layer
6. Link to asset via credentialSubject

**Signing Requirements:**
1. MUST be signed by authorized issuer
2. EdDSA (Ed25519) is default algorithm
3. BBS+ MAY be used for selective disclosure
4. External signers MUST be supported

**Selective Disclosure (Optional):**
- BBS+ cryptosuite enables hiding specific claims
- MAY be used for privacy-sensitive credentials
- MUST preserve verifiability of selective claims

---

## Bitcoin Integration

### Ordinals Protocol Integration

**Inscription Requirements:**
1. Use Taproot (P2TR) output script
2. Encode DID document as JSON
3. Content-Type: `application/did+json`
4. Commit-reveal transaction pattern required
5. Wait for 1+ confirmation before considering final

**Satoshi Assignment:**
1. MUST assign unique satoshi to each inscription
2. MUST validate satoshi not already used
3. MUST track satoshi through transfers
4. MUST prevent accidental destruction of inscription-bearing UTXOs

**Network Support:**
- Mainnet: `did:btco:<satoshi>`
- Testnet: `did:btco:test:<satoshi>` (optional)
- Signet: `did:btco:sig:<satoshi>` (for development)

### Fee Estimation

**Cost Factors:**
1. Commit transaction size (inputs + P2TR output)
2. Reveal transaction size (witness + inscription data)
3. Network fee rate (sat/vB) - dynamic
4. Inscription data size (JSON DID document)

**Estimation Formula:**
```
fee = (commitSize + revealSize) * feeRate
  where:
    commitSize = 182 + (input_count * 148) + (output_count * 34)
    revealSize = 68 + 10 + inscriptionSize + (witness_stack_elements * 34)
    feeRate = current_bitcoin_network_rate_sat_per_vbyte
```

**User Confirmation:**
- MUST estimate fee before migration
- MUST get user confirmation if >threshold (default 1000 sats)
- MUST show fee in user's preferred currency
- MUST allow fee rate adjustment

### Transfer Mechanism

**Ownership Transfer:**
1. Create Bitcoin transaction moving satoshi
2. Update DID document with new owner
3. Inscribe updated document on new satoshi
4. Include reference to previous satoshi
5. Wait for confirmation

**Guarantees:**
- Previous owner cannot reclaim
- New owner has sole signing authority
- Complete transfer history recorded
- No loss of provenance data

---

## Compliance & Validation

### Implementation Compliance

**Tier 1 - Core Features (MUST implement):**
- ✅ did:peer creation and resolution
- ✅ did:webvh creation, update, and resolution
- ✅ did:btco creation and resolution
- ✅ Unidirectional migration enforcement
- ✅ Asset resource versioning
- ✅ W3C Verifiable Credentials
- ✅ EdDSA credential signing
- ✅ Complete audit trail

**Tier 2 - Important Features (SHOULD implement):**
- ⚠️ Bitcoin Ordinals inscription
- ⚠️ External signer support
- ⚠️ Batch operations
- ⚠️ Migration validation pipeline
- ⚠️ Event system
- ⚠️ Storage adapters

**Tier 3 - Advanced Features (MAY implement):**
- BBS+ selective disclosure
- Automated fee optimization
- Migration rate limiting
- Admin dashboards
- Advanced key rotation strategies

### Validation Checklist

Before claiming Originals Protocol v1.0 compliance:

**DID System:**
- [ ] All three DID methods implement W3C spec
- [ ] DID resolution works offline (did:peer)
- [ ] DID resolution works over HTTPS (did:webvh)
- [ ] DID resolution works on Bitcoin (did:btco)
- [ ] DIDs are stable across migrations
- [ ] DID documents are valid JSON-LD

**Asset Management:**
- [ ] Resources are versioned and hashed
- [ ] Metadata is preserved across migrations
- [ ] Provenance chain is complete
- [ ] Ownership is cryptographically verified
- [ ] Ownership can be transferred
- [ ] No data loss during migrations

**Credentials:**
- [ ] Credentials are W3C v2.0 compliant
- [ ] Credentials use JSON-LD (not JWT)
- [ ] Credentials have valid Data Integrity proofs
- [ ] Credentials are re-issuable on new layer
- [ ] Issuer/subject DIDs resolve correctly
- [ ] Selective disclosure works (if implemented)

**Migration System:**
- [ ] Unidirectional progression enforced
- [ ] Backward migration rejected
- [ ] Migration validation required
- [ ] Rollback capability tested
- [ ] Audit logs created
- [ ] Complete in documented timeframe

**Bitcoin Integration:**
- [ ] Inscriptions created correctly
- [ ] Satoshi numbers are unique
- [ ] Transfers preserve satoshi
- [ ] Fees estimated accurately
- [ ] Confirmations tracked
- [ ] No funds lost (critical!)

**Security:**
- [ ] All signatures verified
- [ ] External signers supported
- [ ] Key rotation works
- [ ] No private key leakage
- [ ] Audit logs cryptographically signed
- [ ] Threat model documented

---

## Error Handling

### Error Categories

| Category | Examples | Recovery |
|----------|----------|----------|
| **Validation Errors** | Invalid DID format, missing signature | Reject operation, provide error message |
| **Network Errors** | DNS failure, HTTPS timeout | Retry with exponential backoff |
| **Bitcoin Errors** | Insufficient funds, network congestion | Adjust fee or wait for network |
| **Storage Errors** | Permission denied, quota exceeded | Check storage configuration |
| **Cryptographic Errors** | Invalid signature, key derivation failure | Check keys and inputs |
| **System Errors** | Out of memory, disk full | Return error, clean up partial state |

### Error Handling Requirements

**All Operations MUST:**
1. Catch and categorize errors appropriately
2. Provide human-readable error messages
3. Include error codes for programmatic handling
4. Log full error details for debugging
5. Clean up partial state on failure (for atomic operations)

**Network Operations (HTTPS, Bitcoin):**
1. Implement exponential backoff for retries
2. Max 3 retry attempts (configurable)
3. Timeout after reasonable duration
4. Distinguish transient from permanent failures

**Bitcoin Operations:**
1. Validate input (amounts, addresses, satoshis)
2. Check sufficient funds before attempting
3. Wait for confirmations before confirming success
4. Track transaction status continuously
5. Never broadcast without user confirmation

---

## Performance Requirements

### Target Performance

| Operation | Target | Notes |
|-----------|--------|-------|
| Create did:peer | <100ms | Offline, no network |
| Create did:webvh | <1s | Includes DNS, HTTPS write |
| Inscribe did:btco | <10min | Includes 1 Bitcoin confirmation |
| Transfer did:btco | <10min | Blockchain dependent |
| Migrate peer→webvh | <1s | Validation + DID operations |
| Migrate webvh→btco | <10min | Bitcoin dependent |
| Migrate peer→btco | <10min | Bitcoin dependent |
| Batch 100 assets | <10s | For peer→webvh |
| Batch 10 assets | <100min | For webvh→btco |
| Credential signing | <500ms | EdDSA or BBS+ |
| Credential verification | <200ms | Local verification |

### Scalability Requirements

| Scenario | Target | Notes |
|----------|--------|-------|
| Concurrent peer→webvh migrations | 1000s | Limited by network I/O |
| Concurrent webvh→btco migrations | 10s | Limited by Bitcoin capacity |
| Assets per batch | 100+ | Depends on resource size |
| Resources per asset | 100+ | Versioning support |
| Credentials per asset | 50+ | No practical limit |
| Migrations per asset | 3 | Fixed by architecture |

---

## Related Documents

- **SDK Assessment:** ORIGINALS_SDK_ASSESSMENT.md - Full implementation analysis
- **Executive Summary:** ASSESSMENT_SUMMARY.md - Quick reference guide
- **CLAUDE.md** - Developer guide and architecture patterns

---

**Document Status:** Approved for v1.0 Implementation
**Last Updated:** November 18, 2025
**Next Review:** After v1.0 release
