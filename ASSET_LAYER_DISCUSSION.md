# Asset Layer Discussion - Originals SDK

## Overview

The asset layer in the Originals SDK provides a complete lifecycle management system for digital assets with cryptographically verifiable provenance. It follows a three-tier architecture that balances cost, discoverability, and immutability.

## Core Components

### 1. OriginalsAsset Class (`src/lifecycle/OriginalsAsset.ts`)

The primary representation of a digital asset throughout its lifecycle.

**Key Properties:**
- `id: string` - DID identifier (readonly)
- `resources: AssetResource[]` - Digital content resources (readonly)
- `did: DIDDocument` - W3C DID document (readonly)
- `credentials: VerifiableCredential[]` - Associated credentials (readonly)
- `currentLayer: LayerType` - Current lifecycle layer ('did:peer' | 'did:webvh' | 'did:btco')
- `bindings?: Record<string, string>` - Layer-specific DID bindings
- `provenance: ProvenanceChain` - Complete audit trail (private)

**Core Methods:**
```typescript
// Layer migration with optional Bitcoin details
migrate(toLayer: LayerType, details?: {...}): void

// Retrieve complete provenance history
getProvenance(): ProvenanceChain

// Record ownership transfers
recordTransfer(from: string, to: string, transactionId: string): void

// Cryptographic verification
async verify(deps?: {...}): Promise<boolean>
```

### 2. AssetResource Interface (`src/types/common.ts`)

Defines the structure of digital resources within an asset.

```typescript
interface AssetResource {
  id: string;              // Unique resource identifier
  type: string;            // 'image', 'text', 'code', 'data', etc.
  url?: string;            // Optional resource URL (added during webvh publishing)
  content?: string;        // Optional inline content
  contentType: string;     // MIME type (validated)
  hash: string;            // SHA-256 hash (hex format)
  size?: number;           // Optional size in bytes
}
```

**Validation Requirements:**
- All required fields must be non-empty strings
- `hash` must be valid hex (regex: `/^[0-9a-fA-F]+$/`)
- `contentType` must be valid MIME format
- Content integrity verified via SHA-256 hash

### 3. ProvenanceChain Interface

Complete audit trail tracking asset history.

```typescript
interface ProvenanceChain {
  createdAt: string;       // ISO 8601 timestamp
  creator: string;         // Original creator DID
  txid?: string;           // Latest transaction ID
  migrations: Array<{
    from: LayerType;
    to: LayerType;
    timestamp: string;
    transactionId?: string;
    inscriptionId?: string;
    satoshi?: string;
    commitTxId?: string;
    revealTxId?: string;
    feeRate?: number;
  }>;
  transfers: Array<{
    from: string;
    to: string;
    timestamp: string;
    transactionId: string;
  }>;
}
```

## Three-Layer Architecture

### Layer 1: `did:peer` (Private Creation)
- **Purpose:** Offline experimentation and development
- **Cost:** Free
- **Characteristics:**
  - Assets created with `LifecycleManager.createAsset()`
  - Generates DID:peer document with verification methods
  - Private keys stored in optional `KeyStore`
  - No external hosting required
  - Perfect for prototyping and testing

### Layer 2: `did:webvh` (Public Discovery)
- **Purpose:** Web-based discovery and verification
- **Cost:** ~$25/year (hosting)
- **Characteristics:**
  - Migrated via `LifecycleManager.publishToWeb(asset, domain)`
  - Resources uploaded to storage adapter
  - URLs added to resources
  - Creates `did:webvh` binding
  - Issues `ResourceMigrated` credential
  - Enables public discoverability via HTTPS

**Migration Details:**
- Resources published under `.well-known/webvh/{slug}/resources/{multibase-hash}`
- Generates content-addressed URLs
- Preserves original DID while adding webvh binding
- Credentials signed with original DID's private key

### Layer 3: `did:btco` (Bitcoin Ownership)
- **Purpose:** Transferable ownership on Bitcoin
- **Cost:** $75-200 (one-time inscription fee)
- **Characteristics:**
  - Inscribed via `LifecycleManager.inscribeOnBitcoin(asset, feeRate?)`
  - Creates Bitcoin Ordinals inscription
  - Manifest includes asset metadata and resource hashes
  - Assigns unique satoshi identifier
  - Enables P2P ownership transfers
  - Front-running protection via unique sat assignment

**Inscription Manifest:**
```json
{
  "assetId": "did:peer:...",
  "resources": [
    { "id": "...", "hash": "...", "contentType": "...", "url": "..." }
  ],
  "timestamp": "2025-10-04T..."
}
```

## Valid Migration Paths

```
did:peer → did:webvh → did:btco
did:peer → did:btco (direct)
```

**Invalid Paths (throws error):**
- Backward migration (e.g., did:btco → did:webvh)
- From did:btco to any layer (terminal state)
- Any non-sequential path

## Asset Verification System

The `verify()` method performs multi-layered validation:

### 1. DID Document Validation
- Structure validation via `validateDIDDocument()`
- Supported method check (peer, webvh, btco)
- Controller and verification method integrity

### 2. Resource Integrity
- Structural validation (required fields, types)
- Hash format validation (hex characters only)
- **Inline content:** SHA-256 hash verification
- **URL content:** Optional fetch and hash verification (with provided fetch function)
- Graceful degradation on fetch failures

### 3. Credential Validation
- Structure validation via `validateCredential()`
- W3C VC standard compliance
- **Optional:** Cryptographic signature verification (with CredentialManager)
- All credentials must be valid for asset to verify

### 4. Error Handling
- Returns `false` on any validation failure
- Catches unexpected errors (returns `false`)
- No throwing - always returns boolean

## LifecycleManager (`src/lifecycle/LifecycleManager.ts`)

Orchestrates asset lifecycle operations.

### Key Operations

#### 1. Create Asset
```typescript
async createAsset(resources: AssetResource[]): Promise<OriginalsAsset>
```
- Validates all resources
- Creates DID:peer document
- Generates and stores key pair (if KeyStore provided)
- Returns asset in 'did:peer' layer

#### 2. Publish to Web
```typescript
async publishToWeb(asset: OriginalsAsset, domain: string): Promise<OriginalsAsset>
```
- Validates domain format
- Uploads resources to storage adapter
- Generates content-addressed URLs
- Creates webvh binding
- Issues signed `ResourceMigrated` credential
- Updates provenance

#### 3. Inscribe on Bitcoin
```typescript
async inscribeOnBitcoin(asset: OriginalsAsset, feeRate?: number): Promise<OriginalsAsset>
```
- Creates inscription manifest
- Uses BitcoinManager to inscribe data
- Optionally uses FeeOracle for rate estimation
- Records inscription details in provenance
- Creates btco binding
- Returns asset in 'did:btco' layer

#### 4. Transfer Ownership
```typescript
async transferOwnership(asset: OriginalsAsset, newOwner: string): Promise<BitcoinTransaction>
```
- Validates Bitcoin address (network-aware)
- Only works for 'did:btco' layer assets
- Uses BitcoinManager to transfer inscription
- Records transfer in provenance
- Returns transaction details

### Key Store Integration

The `KeyStore` interface enables external key management:

```typescript
interface KeyStore {
  getPrivateKey(verificationMethodId: string): Promise<string | null>;
  setPrivateKey(verificationMethodId: string, privateKey: string): Promise<void>;
}
```

**Benefits:**
- Supports external signers (Privy, AWS KMS, HSMs)
- Keys stored securely outside SDK
- Required for credential issuance
- Multibase-encoded private keys

## Integration with SDK Components

### DIDManager
- Creates DID documents for all layers
- Resolves DIDs for verification
- Extracts verification methods for signing
- Supports did:peer, did:webvh, did:btco methods

### CredentialManager
- Issues verifiable credentials during migrations
- Signs credentials with private keys from KeyStore
- Verifies credential signatures
- Supports Data Integrity Proofs

### BitcoinManager
- Handles Bitcoin Ordinals inscriptions
- Manages UTXO selection and transaction building
- Transfers inscriptions between addresses
- Integrates with OrdinalsProvider adapter

### Storage Adapters
- MemoryStorageAdapter (testing)
- Custom adapters via StorageAdapter interface
- Content-addressed resource storage
- Domain-based organization

## Testing Coverage

### Unit Tests (`tests/unit/lifecycle/OriginalsAsset.test.ts`)
- Layer determination from DID
- Migration path validation
- Provenance tracking
- Verification (DID, resources, credentials)
- Hash integrity checks
- Error handling

### Integration Tests (`tests/integration/CompleteLifecycle.e2e.test.ts`)
- Full lifecycle: peer → webvh → btco → transfer
- Provenance tracking across layers
- Adapter integration (storage, fee oracle, ordinals)
- Resource URL generation
- Credential issuance and verification
- Multi-transfer scenarios
- Large payloads and many resources
- Timestamp monotonicity

## Design Patterns

### 1. Unidirectional Flow
Assets can only move forward through layers, never backward. This ensures economic gravity and prevents confusion about asset state.

### 2. Provenance Immutability
The provenance chain is append-only. Once a migration or transfer is recorded, it cannot be removed, providing a complete audit trail.

### 3. Layer Bindings
Assets maintain bindings to their identifiers at each layer, enabling cross-layer references and verification.

### 4. Graceful Degradation
Verification works at multiple levels - structural, content integrity, and cryptographic - with graceful degradation when optional dependencies aren't available.

### 5. Adapter Pattern
Storage, fee oracles, and ordinals providers are pluggable via adapter interfaces, enabling testing and custom integrations.

## Key Validation Rules

### Asset Creation
- ✅ At least one resource required
- ✅ All resources must have valid structure
- ✅ Hashes must be 64-character hex strings
- ✅ Content types must be valid MIME formats
- ✅ IDs must be non-empty strings

### Domain Publishing
- ✅ Valid domain format (RFC-compliant)
- ✅ Asset must be in 'did:peer' layer
- ✅ Storage adapter must be configured
- ✅ KeyStore required for credential signing

### Bitcoin Inscription
- ✅ Asset must be in 'did:peer' or 'did:webvh' layer
- ✅ Fee rate: 1-1,000,000 sat/vB (if provided)
- ✅ OrdinalsProvider must be configured
- ✅ Sufficient funds for inscription

### Ownership Transfer
- ✅ Asset must be in 'did:btco' layer
- ✅ Valid Bitcoin address for target network
- ✅ Network-aware validation (mainnet/testnet/regtest/signet)

## Common Use Cases

### Digital Art
1. Create asset with image resources (`did:peer`)
2. Publish for portfolio/discovery (`did:webvh`)
3. Inscribe on Bitcoin upon sale (`did:btco`)
4. Transfer ownership to buyer

### Scientific Data
1. Create dataset asset privately (`did:peer`)
2. Publish for peer review (`did:webvh`)
3. Anchor provenance on Bitcoin (`did:btco`)
4. Enable citation and verification

### Supply Chain
1. Create product credential (`did:peer`)
2. Publish public registry (`did:webvh`)
3. Inscribe for anti-counterfeiting (`did:btco`)
4. Transfer through supply chain

## Key Insights

1. **Economic Gravity:** The three-layer model aligns cost with value - start free, pay for discovery, invest in permanence.

2. **Front-Running Protection:** Unique satoshi assignment prevents inscription front-running attacks.

3. **Verifiable Provenance:** Complete audit trail from creation through all migrations and transfers.

4. **Content Integrity:** SHA-256 hashes ensure resource authenticity at every layer.

5. **Flexible Verification:** Multi-level verification enables different trust models based on available resources.

6. **Standards Compliance:** Full W3C DID and Verifiable Credentials compliance ensures interoperability.

7. **Adapter Extensibility:** Pluggable adapters enable custom storage, fee estimation, and Bitcoin providers.

## Open Questions / Discussion Topics

1. **Layer Transitions:** Should there be time locks or minimum durations at each layer?

2. **Resource Updates:** How should resource updates be handled at different layers?

3. **Credential Policies:** Should there be validation policies for different credential types?

4. **Transfer Restrictions:** Should there be optional transfer restrictions or royalty mechanisms?

5. **Multi-sig Support:** How would multi-signature requirements integrate with the current model?

6. **Layer Skipping:** Should peer → btco direct migration be encouraged or discouraged?

7. **Provenance Queries:** Should there be query APIs for filtering/searching provenance history?

8. **Resource Versioning:** How should resource versioning be handled within the asset model?

## Related Documentation

- Main README: `/workspace/README.md`
- OriginalsAsset implementation: `/workspace/src/lifecycle/OriginalsAsset.ts`
- LifecycleManager implementation: `/workspace/src/lifecycle/LifecycleManager.ts`
- Complete lifecycle tests: `/workspace/tests/integration/CompleteLifecycle.e2e.test.ts`
- Asset unit tests: `/workspace/tests/unit/lifecycle/OriginalsAsset.test.ts`
- Type definitions: `/workspace/src/types/common.ts`
