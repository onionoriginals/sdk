# Originals Protocol - Technical Specification Summary

This document provides a high-level overview of the complete technical specification.

## What is Originals?

Originals is a protocol for creating, discovering, and transferring digital assets with cryptographically verifiable provenance. It separates economic concerns across three layers, allowing creators to start cheaply and migrate to Bitcoin only when value justifies the cost.

## Three-Layer Architecture

### Layer 1: did:peer (Creation)
- **Cost**: Free
- **Security**: High (self-contained)
- **Purpose**: Private experimentation and creation
- **Use Case**: Artists sketching ideas, developers prototyping

### Layer 2: did:webvh (Discovery)
- **Cost**: ~$25/year (domain hosting)
- **Security**: Medium (HTTPS)
- **Purpose**: Public discovery and sharing
- **Use Case**: Portfolio websites, public galleries

### Layer 3: did:btco (Ownership)
- **Cost**: $75-200 one-time (Bitcoin fees)
- **Security**: Maximum (Bitcoin blockchain)
- **Purpose**: Transferable ownership and permanent record
- **Use Case**: Sales, high-value assets, legal ownership

## Key Features

### 1. Economic Gravity Model
Assets naturally migrate to appropriate security levels based on value:
- Experiments stay in peer layer (free)
- Public portfolios use webvh layer (cheap)
- Sales trigger btco inscription (secure)

### 2. Unidirectional Migration
Assets can only move forward through layers, never backward:
- ✅ peer → webvh → btco
- ✅ peer → btco (skip webvh)
- ❌ btco → webvh (not allowed)

### 3. Front-Running Prevention
Bitcoin's ordinal theory ensures:
- Each satoshi is unique
- First inscription wins
- No double-spending of inscription slots

### 4. Standards Compliance
Built entirely on W3C standards:
- DID Core Specification
- Verifiable Credentials Data Model 2.0
- Data Integrity Proofs
- Multikey verification methods

## Core Components

### OriginalsSDK
Main entry point providing:
```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  defaultKeyType: 'ES256K',
  enableLogging: true
});
```

### DIDManager
Handles all three DID methods:
- Create did:peer (offline, self-contained)
- Migrate to did:webvh (hosted on web)
- Migrate to did:btco (inscribed on Bitcoin)
- Resolve any DID back to its document

### CredentialManager
Issues and verifies credentials:
- ResourceCreated (asset creation)
- ResourceMigrated (layer transitions)
- VerifiableCollectible (authenticated art)
- CuratedCollection (gallery collections)

### LifecycleManager
Orchestrates asset lifecycle:
- `createAsset()` - Start in peer layer
- `publishToWeb()` - Migrate to webvh
- `inscribeOnBitcoin()` - Migrate to btco
- `transferOwnership()` - Transfer in btco layer

### BitcoinManager
Handles Bitcoin operations:
- Inscribe data on Bitcoin
- Transfer inscriptions
- Track inscription status
- Prevent front-running attacks

## Typical Workflow

```typescript
// 1. Create asset (free, offline)
const asset = await sdk.lifecycle.createAsset([{
  id: 'artwork-001',
  type: 'image',
  contentType: 'image/png',
  hash: 'sha256-hash',
  content: 'image-data'
}]);
// Asset is now at: did:peer:...

// 2. Publish to web ($25/year)
await sdk.lifecycle.publishToWeb(asset, 'artist.com');
// Asset is now at: did:webvh:artist.com:...

// 3. Inscribe on Bitcoin ($75-200 one-time)
await sdk.lifecycle.inscribeOnBitcoin(asset);
// Asset is now at: did:btco:1234567...

// 4. Transfer to buyer (transfer fee only)
await sdk.lifecycle.transferOwnership(asset, 'buyer-address');
// Ownership transferred on-chain

// 5. Verify provenance
const provenance = asset.getProvenance();
// Shows complete history: creation → webvh → btco → transfer
```

## Data Models

### OriginalsAsset
Represents a digital asset through its lifecycle:
- **id**: Current DID
- **resources**: Content with integrity hashes
- **did**: Current DID Document
- **credentials**: Associated verifiable credentials
- **currentLayer**: peer, webvh, or btco
- **provenance**: Complete history

### ProvenanceChain
Complete audit trail:
- **creator**: Original creator DID
- **createdAt**: Creation timestamp
- **migrations**: All layer transitions
- **transfers**: All ownership changes
- **txid**: Latest Bitcoin transaction

### AssetResource
Individual content item:
- **id**: Resource identifier
- **type**: Content type (image, text, etc.)
- **hash**: SHA-256 integrity hash
- **contentType**: MIME type
- **content**: Optional inline data
- **url**: Optional hosted location

## Security Features

### Cryptographic Provenance
Every operation is cryptographically signed:
- Asset creation signed by creator
- Migrations include credentials
- Transfers recorded on Bitcoin
- Full verification possible at any time

### Key Management
- Multiple key types supported (Ed25519, secp256k1, P-256)
- Multikey encoding (no JSON Web Keys)
- Secure key generation
- Hardware security module support

### Bitcoin Security
- Immutable inscription storage
- UTXO-based ownership
- Front-running prevention via ordinal uniqueness
- 6-confirmation finality recommended

## Integration Points

### Storage Adapters
Pluggable storage for webvh resources:
- Local filesystem (development)
- S3-compatible cloud storage
- IPFS (future)

### Fee Oracles
Bitcoin fee estimation:
- External fee oracle APIs
- Ordinals provider estimates
- User-specified overrides

### Ordinals Providers
Bitcoin inscription operations:
- Ord HTTP API
- Custom indexers
- Mock providers (testing)

## Implementation Status

### ✅ Fully Implemented
- Three-layer DID creation and migration
- Asset lifecycle management
- Credential issuance and verification
- Bitcoin inscription via ordinals
- Provenance tracking
- Resource integrity verification

### ⚠️ Partially Implemented
- ES256 key support (fallback to Ed25519)
- BBS+ selective disclosure
- Credential status lists
- Collection resolution

### 📋 Specified but Not Implemented
- Heritage collection traversal
- Curated collection resolution
- Status list credential checking
- Batch inscription operations

## Testing Requirements

### Unit Tests
All core components have comprehensive unit tests:
- DID operations (creation, migration, resolution)
- Credential operations (issuance, verification)
- Lifecycle transitions
- Bitcoin operations (mocked and real)

### Integration Tests
End-to-end workflows:
- Complete asset lifecycle
- Cross-layer migrations
- Provider integration
- Storage adapter integration

### Test Coverage
Current coverage: ~85% (see badges/coverage.svg)

## Known Limitations

1. **Bitcoin finality**: ~10 minutes per confirmation
2. **Fee volatility**: Bitcoin fees can spike unexpectedly
3. **Inscription permanence**: Cannot delete inscriptions
4. **WebVH centralization**: Requires domain ownership and HTTPS
5. **Key recovery**: Lost Bitcoin keys = lost DID control

## Use Cases

### Digital Art
Artists create privately, publish for discovery, inscribe upon sale:
```
Sketch → Portfolio → Sale → Collector
(peer)   (webvh)    (btco)   (transfer)
Free     $25/year   $150     $5/transfer
```

### Scientific Data
Researchers document privately, publish for review, anchor provenance:
```
Dataset → Preprint → Publication
(peer)    (webvh)   (btco)
```

### Supply Chain
Manufacturers create records, publish registries, inscribe ownership:
```
Production → Registry → Transfer
(peer)       (webvh)   (btco)
```

### DAO Governance
Issue credentials privately, publish for recognition, inscribe key decisions:
```
Proposal → Vote → Execution
(peer)     (webvh) (btco)
```

## Architecture Principles

### 1. Separation of Concerns
- **Creation**: DIDManager handles all DID operations
- **Credentials**: CredentialManager handles VCs
- **Lifecycle**: LifecycleManager orchestrates transitions
- **Bitcoin**: BitcoinManager handles inscriptions

### 2. Pluggable Dependencies
- Storage adapters (local, cloud, IPFS)
- Fee oracles (multiple sources)
- Ordinals providers (ord, custom indexers)
- Telemetry hooks (logging, monitoring)

### 3. Standards First
- W3C DID Core compliance
- W3C VC Data Model 2.0 compliance
- No proprietary formats
- Interoperable with other DID/VC systems

### 4. Developer Experience
- Simple API: `create()`, `publishToWeb()`, `inscribeOnBitcoin()`
- TypeScript types for all models
- Comprehensive error handling
- Detailed telemetry

## Error Handling

### Validation Errors
- Invalid DID format
- Invalid migration transitions
- Invalid domain names
- Invalid satoshi numbers

### Network Errors
- Bitcoin RPC unreachable
- Ordinals indexer down
- Storage adapter failures
- Fee oracle unavailable

### Cryptographic Errors
- Invalid signatures
- Unsupported key types
- Tampered credentials
- Missing verification methods

All errors use structured format with codes and context for debugging.

## Future Enhancements

### High Priority
- Batch inscription operations (cost savings)
- Complete credential status lists
- Enhanced collection resolution

### Medium Priority
- Multi-signature DID control
- Additional storage adapters (IPFS)
- Cross-chain bridge support

### Low Priority
- Zero-knowledge proof credentials
- Alternative blockchain support
- Mobile SDK variants

## Getting Started

```bash
# Install
npm install @originals/sdk

# Basic usage
import { OriginalsSDK } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'testnet',
  enableLogging: true
});

const asset = await sdk.lifecycle.createAsset(resources);
await sdk.lifecycle.publishToWeb(asset, 'example.com');
await sdk.lifecycle.inscribeOnBitcoin(asset);
```

## Key Decisions & Rationale

### Why Three Layers?
**Economic efficiency**: Not every asset needs Bitcoin security. Let value determine security level.

### Why Unidirectional?
**Integrity guarantee**: Once committed to higher security, can't downgrade. Maintains trust.

### Why Bitcoin?
**Maximum security**: Most secure, decentralized, and liquid blockchain. Proven track record.

### Why No JWT?
**JSON-LD native**: Data Integrity proofs work better with JSON-LD. More flexible and expressive.

### Why Multikey?
**Future-proof**: Supports multiple algorithms. No vendor lock-in. Better than JWK for DIDs.

### Why Content Hashing?
**Integrity verification**: Prove content matches without revealing content. Enables off-chain storage.

## Quick Reference

### Layer Comparison
| Feature | did:peer | did:webvh | did:btco |
|---------|----------|-----------|----------|
| Cost | Free | ~$25/year | $75-200 |
| Speed | Instant | Seconds | ~10 min |
| Security | High | Medium | Maximum |
| Transferable | No | No | Yes |
| Public | No | Yes | Yes |

### Common Operations
- **Create**: `sdk.lifecycle.createAsset(resources)`
- **Publish**: `sdk.lifecycle.publishToWeb(asset, domain)`
- **Inscribe**: `sdk.lifecycle.inscribeOnBitcoin(asset)`
- **Transfer**: `sdk.lifecycle.transferOwnership(asset, address)`
- **Verify**: `asset.verify({ didManager, credentialManager })`

### Required Configuration
- `network`: 'mainnet' | 'testnet' | 'regtest'
- `defaultKeyType`: 'ES256K' | 'Ed25519' | 'ES256'

### Optional Configuration
- `bitcoinRpcUrl`: Ordinals indexer endpoint
- `storageAdapter`: For webvh resource hosting
- `feeOracle`: Bitcoin fee estimation
- `ordinalsProvider`: Bitcoin inscription operations

---

## Related Documents

- **TECHNICAL_SPECIFICATION.md**: Complete technical specification (13,000+ words)
- **README.md**: SDK usage and installation
- **BTCO DID Method**: Specification for did:btco
- **BTCO Linked Resources**: Specification for resource addressing
- **BTCO Verifiable Metadata**: Specification for credentials

---

**For implementation teams**: Start with the main README.md, then refer to TECHNICAL_SPECIFICATION.md for detailed requirements. Use this summary for architecture discussions and design reviews.

**For code reviewers**: Use Section 8 (Testing & Validation) to verify completeness. Check Section 10 (Assumptions) for known limitations.

**For security auditors**: Focus on Section 9 (Security Considerations) and Section 7 (Error Handling).
