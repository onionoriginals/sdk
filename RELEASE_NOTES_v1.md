# Originals SDK v1 - Release Notes

**Package:** `@originals/sdk`
**Current Version:** 1.9.0
**Initial Release:** November 19, 2025
**Milestone Date:** March 6, 2026
**License:** MIT
**Runtime:** Bun 1.3.5 / Node.js 18+

---

## What is the Originals SDK?

The Originals SDK is a TypeScript implementation of the Originals Protocol -- an open standard for creating, discovering, and transferring digital assets with cryptographically verifiable provenance. It provides a complete toolkit for managing digital asset lifecycles across three decentralized identity layers:

- **did:peer** -- Private creation and experimentation (offline, free)
- **did:webvh** -- Public discovery via HTTPS hosting
- **did:btco** -- Transferable ownership on Bitcoin

Assets migrate unidirectionally through these layers, with economic gravity determining when Bitcoin-level security is justified.

## Architecture

The SDK is built around four core managers orchestrated by `OriginalsSDK`:

| Manager | Responsibility |
|---------|---------------|
| `DIDManager` | DID document creation and resolution across all three methods |
| `CredentialManager` | W3C Verifiable Credential issuance and verification |
| `LifecycleManager` | Asset creation, migration between layers, batch operations |
| `BitcoinManager` | Bitcoin inscription (Ordinals) and ownership transfer |

### Key Design Decisions

- **Multikey encoding** throughout (no JWK) -- multibase + multicodec for all key material
- **Data Integrity proofs** for credentials (not JWT) -- EdDSA and BBS+ cryptosuites
- **External signer pattern** -- pluggable key management via `ExternalSigner` interface (Turnkey, AWS KMS, HSMs)
- **Commit-reveal inscription** -- two-phase Bitcoin inscription for front-running protection
- **Event-driven lifecycle** -- type-safe `EventEmitter` for all asset state changes
- **Pluggable storage** -- `StorageAdapter` interface with memory and localStorage implementations

## Features

### DID Operations
- Create `did:peer` identifiers offline using `@aviarytech/did-peer`
- Migrate to `did:webvh` for public discovery with version history (JSONL logs)
- Inscribe `did:btco` on Bitcoin Ordinals for permanent, transferable ownership
- Universal DID resolution across all three methods
- Key generation for ES256K (secp256k1), Ed25519, and ES256 (secp256r1)

### Verifiable Credentials
- W3C-compliant JSON-LD credential signing
- EdDSA cryptosuite (Ed25519) for standard signatures
- BBS+ cryptosuite for selective disclosure
- Ownership credentials issued automatically on publication
- Full Data Integrity proof chain verification

### Asset Lifecycle
- Create assets with arbitrary resources and metadata
- Publish to web with automatic DID migration and credential issuance
- Inscribe on Bitcoin with ordinal-aware UTXO selection
- Batch operations with validation pipeline, checkpoints, and rollback
- Immutable resource versioning

### Bitcoin Integration
- Ordinals-based inscription via commit-reveal pattern
- Inscription ownership transfer with DID document updates
- Configurable fee estimation (static or oracle-based)
- Network support: mainnet, signet, regtest
- Pluggable providers: `OrdMockProvider` (testing), `OrdinalsClient` (production)

### Multi-Network WebVH Deployments
- **pichu.originals.build** -- Production (mainnet), major releases only
- **cleffa.originals.build** -- Staging (signet), minor releases
- **magby.originals.build** -- Development (regtest), all versions
- Automatic Bitcoin network mapping per WebVH environment
- Semantic version enforcement per network tier

### Developer Experience
- Comprehensive API reference documentation
- LLM agent guide for code generation
- Subpath exports for bundler compatibility (Convex, Vite, etc.)
- Structured error handling via `StructuredError`
- Configurable logging with sensitive data sanitization
- Turnkey-based authentication (`@originals/auth` package)

## Test Coverage

**1,981 tests passing across 99 test files, 0 failures.**

| Suite | Tests | Files | Duration |
|-------|-------|-------|----------|
| Integration | 103 | 14 | 694ms |
| Unit | 1,793 | 83 | 4.55s |
| Security | 67 | 1 | 109ms |
| Stress | 18 | 1 | 15.2s |

Coverage areas include:
- All four manager APIs (DID, Credentials, Lifecycle, Bitcoin)
- Cryptographic operations (Multikey, EdDSA, BBS+, ES256K)
- Bitcoin transaction logic (commit, reveal, UTXO selection, fee calculation)
- Migration state machine, validation pipeline, checkpoint/rollback
- Auth package (Turnkey integration, session management)
- Security audit (path traversal, input validation, injection prevention)
- Stress benchmarks (2,664 assets/sec creation throughput)

## Dependencies

Core cryptographic libraries:
- `@noble/curves`, `@noble/hashes`, `@noble/secp256k1`, `@noble/ed25519` -- audited, pure-JS crypto
- `@scure/base`, `@scure/bip32`, `@scure/btc-signer` -- Bitcoin primitives
- `@aviarytech/did-peer` -- DID:peer method
- `didwebvh-ts` -- DID:WebVH method with version history
- `micro-ordinals` -- Ordinals inscription encoding
- `multiformats` -- Multicodec/multibase encoding
- `jsonld` -- JSON-LD processing for credentials

## Version History (v1.0.0 - v1.9.0)

| Version | Type | Summary |
|---------|------|---------|
| 1.0.0 | Initial | Core SDK with DID, VC, Lifecycle, and Bitcoin managers |
| 1.1.0 | Feature | Initial public release |
| 1.2.0 | Feature | Dependency updates |
| 1.3.0 | Feature | Turnkey auth, LLM agent docs, Bun publishing |
| 1.4.x | Fix | npm publishing fixes, dist configuration |
| 1.5.0 | Feature | Auth refactor: removed React deps, added Turnkey support |
| 1.6.0 | Feature | Originals CEL integration |
| 1.7.0 | Feature | Turnkey client integration refactor |
| 1.8.0 | Feature | Migrated to @turnkey/sdk-server |
| 1.8.x | Fix | Package exports, type compatibility |
| 1.9.0 | Feature | Subpath exports for Convex bundler compatibility |

## Phase 1 Completion Summary

The following roadmap items have been completed as part of the v1 milestone:

- **AuditLogger signatures** (ORI-4) -- Resolved placeholder signatures with real implementations
- **Auth spec deviations** (ORI-6) -- Fixed 3 spec compliance issues in the auth package
- **Auth test coverage** (ORI-7) -- Increased from 12% to 80%+ with 123 new tests across 6 files
- **Bitcoin inscription + transfer** (ORI-8) -- Implemented inscription and ownership transfer, closed GitHub issues #71, #72, #79, #80; added 38 new tests

## Installation

```bash
npm install @originals/sdk
# or
bun add @originals/sdk
```

## Quick Start

```typescript
import { OriginalsSDK, OrdMockProvider } from '@originals/sdk';

const originals = OriginalsSDK.create({
  webvhNetwork: 'magby',        // development network
  enableLogging: true,
  ordinalsProvider: new OrdMockProvider()
});

// Create a digital asset (did:peer layer)
const asset = await originals.lifecycle.createAsset([{
  id: 'artwork-001',
  type: 'image',
  contentType: 'image/png',
  hash: 'sha256-abc123...'
}]);

// Publish for discovery (did:webvh layer)
await originals.lifecycle.publishToWeb(asset, 'example.com');

// Inscribe on Bitcoin (did:btco layer)
await originals.lifecycle.inscribeOnBitcoin(asset);
```

## Links

- Repository: https://github.com/onionoriginals/sdk
- npm: https://www.npmjs.com/package/@originals/sdk
- API Reference: `docs/LLM_AGENT_GUIDE.md`
