# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## LLM Agent Documentation

For comprehensive API reference optimized for code generation, see:
- **[docs/LLM_AGENT_GUIDE.md](docs/LLM_AGENT_GUIDE.md)** - Full API reference with signatures, types, and examples
- **[docs/LLM_QUICK_REFERENCE.md](docs/LLM_QUICK_REFERENCE.md)** - Compact quick-reference card

## Project Overview

This is a TypeScript SDK for the Originals Protocol - enabling creation, discovery, and transfer of digital assets with cryptographically verifiable provenance. The protocol organizes digital asset lifecycles into three layers:

- **`did:peer`** - Private creation and experimentation (offline, free)
- **`did:webvh`** - Public discovery via HTTPS hosting
- **`did:btco`** - Transferable ownership on Bitcoin

Assets migrate unidirectionally through these layers: did:peer → did:webvh → did:btco.

## Build and Test Commands

### Build
```bash
bun run build
```
This compiles TypeScript from `packages/sdk/src/` to `packages/sdk/dist/`.

### Testing
```bash
# Run all tests (integration, unit, security, stress)
bun test

# Run from root (runs SDK tests)
bun run test

# Run with coverage
bun run test:coverage

# Run specific test suites
cd packages/sdk && bun test tests/integration
cd packages/sdk && bun test tests/unit
cd packages/sdk && bun test tests/security
cd packages/sdk && bun test tests/stress

# Run a single test file
bun test packages/sdk/tests/unit/crypto/Multikey.test.ts
```

### Linting
```bash
bun run lint
```

### Development Notes
- The project uses Bun as the runtime and package manager
- Test setup is in `packages/sdk/tests/setup.bun.ts` (preloaded via bunfig.toml)
- Console output is suppressed during tests to reduce noise

## Architecture

### Core System Design

The SDK is built around a layered architecture with clear separation of concerns:

**OriginalsSDK (src/core/OriginalsSDK.ts)** - Main entry point that orchestrates all managers:
- `did: DIDManager` - DID document creation and resolution
- `credentials: CredentialManager` - Verifiable credential handling
- `lifecycle: LifecycleManager` - Asset migration between layers
- `bitcoin: BitcoinManager` - Bitcoin/Ordinals integration

### DID Layer Architecture (src/did/)

The DID system supports three DID methods with unified interfaces:

**DIDManager (DIDManager.ts)** - Central orchestrator for all DID operations
- `createDIDPeer()` - Create offline did:peer identifiers using @aviarytech/did-peer
- `migrateToDIDWebVH()` - Upgrade did:peer to did:webvh for public hosting
- `migrateToDIDBtco()` - Inscribe DID on Bitcoin for permanent ownership
- `resolveDID()` - Universal resolver for all three DID methods

**WebVHManager (WebVHManager.ts)** - did:webvh-specific operations
- Integrates with didwebvh-ts library for version history DIDs
- Supports external signers (Turnkey, AWS KMS, HSMs) via ExternalSigner interface
- Creates/updates DID logs as JSONL files for .well-known hosting
- Key methods: `createDIDWebVH()`, `updateDIDWebVH()`, `loadDIDLog()`

**BtcoDidResolver (BtcoDidResolver.ts)** - did:btco resolution
- Resolves DIDs inscribed on Bitcoin Ordinals
- Uses OrdinalsProvider interface for blockchain queries
- Validates satoshi numbers and inscription integrity

**KeyManager (KeyManager.ts)** - Cryptographic key generation
- Supports ES256K (secp256k1), Ed25519, and ES256 (secp256r1)
- Generates Multikey-formatted keys (multibase encoding)
- Used by all DID methods for key creation

### External Signer Pattern

The SDK supports external key management for production deployments:

```typescript
interface ExternalSigner {
  sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }): Promise<{ proofValue: string }>;
  getVerificationMethodId(): string;
}
```

This enables integration with:
- Turnkey for user key management
- AWS KMS for enterprise key custody
- Hardware Security Modules (HSMs)
- Other secure key management systems

Key files: `src/types/common.ts`, `src/did/WebVHManager.ts`

### Bitcoin Integration Architecture (src/bitcoin/)

**BitcoinManager (BitcoinManager.ts)** - High-level Bitcoin operations
- `inscribeData()` - Inscribe arbitrary data as Ordinals
- `transferInscription()` - Transfer inscription ownership
- `inscribeDID()` - Create did:btco by inscribing DID document
- `transferDID()` - Transfer did:btco ownership (updates DID document)

**Commit-Reveal Pattern (bitcoin/transactions/commit.ts)**
- Bitcoin inscriptions use two-phase commit for front-running protection
- Commit transaction: Creates unique satoshi assignment
- Reveal transaction: Inscribes actual data on that satoshi
- UTXO selection (utxo-selection.ts) ensures ordinal-awareness

**OrdinalsProvider Interface (adapters/types.ts)**
- Abstract interface for Bitcoin operations
- OrdMockProvider: Testing/development implementation
- OrdinalsClient: Production Bitcoin integration
- Allows pluggable backends (local ord daemon, API services, etc.)

**Fee Management**
- Optional FeeOracleAdapter for dynamic fee estimation
- Falls back to OrdinalsProvider fee estimation
- Configurable fee rates per operation

### Lifecycle Management (src/lifecycle/)

An Original asset **IS a CEL** (Cryptographic Event Log, src/cel/): every *authorship* lifecycle operation appends a signed event to `asset.celLog`, and the log — not the in-memory caches — is the source of provenance truth. Ownership is the exception: it IS Bitcoin sat control, read live (`getCurrentOwner()`), and a transfer writes nothing to the CEL.

**LifecycleManager (LifecycleManager.ts)** - Orchestrates asset migration; each authorship op appends a signed CEL event (transfers are the exception — pure sat moves)
- `createAsset()` - Mints a `did:cel` genesis (`create` event); `asset.id` is the derived did:cel, while `currentLayer` label stays `'did:peer'`
- `publishToWeb()` - Migrates to did:webvh (`migrate` event)
- `inscribeOnBitcoin()` - Migrates to did:btco (`migrate` event); the on-chain DID doc carries an `OriginalsCelAnchor` (`#cel` service) committing to the log head at inscription time, and IS the witness artifact for the event's bitcoin proof
- `transferOwnership()` - A pure Bitcoin **sat move** — writes NOTHING to the CEL (ownership IS sat control; the CEL is authorship only). Ownership is read live via `getCurrentOwner()`, never from a log event. The `transfer` CEL event type is legacy/read-only (verifiers still accept it in old logs; the SDK no longer emits it). `rotateBtcoKeys()` reinscribes same-id doc with a new key (`rotateKey` event, COOPERATIVE — signed by the outgoing controller), re-embedding a fresher `#cel`
- `authorizeSigner()` - OPTIONAL author-enablement (#366, renamed from `claimOwnership`): does NOT grant or claim ownership (the sat is ownership). It lets a sat holder who cannot obtain the seller's signature establish a signing key so they can author new provenance — they reinscribe the did:btco doc with THEIR key and SELF-SIGN the `rotateKey`; the reinscription witness proves sat control, and the verifier accepts the otherwise-unauthorized rotation. `privateKey` is REQUIRED. Contrast with the cooperative `rotateBtcoKeys`.
- `asset.serialize()` / `lifecycle.loadAsset()` - The interchange format (#377): `serialize()` emits a self-describing `AssetEnvelope` (the CEL log + captured DID docs + resources + an `unverified` honesty section); `loadAsset()` is the inverse and VERIFIES BY DEFAULT — same `verifyEventLog` gate plus resource↔genesis binding and DID-doc↔fold cross-checks, all fail-closed. With an ordinalsProvider it sets `checkHeadFreshness`, rejecting a truncated pre-rotation hand-off as `STALE_LOG` (#366).
- Event-driven architecture via EventEmitter; when no keyStore/signing key is available, appends degrade with a `cel:append-skipped` event (verification is public-key-only and needs no keys; only WRITING needs the controller key)
- Batch operations support for multiple assets

**OriginalsAsset (OriginalsAsset.ts)** - Asset representation, backed by its CEL log
- Encapsulates resources, credentials, and provenance
- Tracks migration state across layers; `replayProvenance` folds the log to reconstruct it
- `verify()` delegates to `verifyEventLog` — gating on the whole signed chain (btco anchoring needs an `ordinalsProvider` to check the witness proof)
- Version management for resource updates

**BatchOperations (BatchOperations.ts)**
- Execute multiple operations atomically
- Validation pipeline ensures consistency
- Rollback support on partial failures

### Verifiable Credentials (src/vc/)

**CredentialManager (CredentialManager.ts)** - W3C Verifiable Credential handling
- JSON-LD credential signing (not JWT)
- Data Integrity proofs using EdDSA and BBS+ cryptosuites
- Integration with DIDManager for issuer/subject resolution

**Cryptosuites (vc/cryptosuites/)**
- `eddsa.ts` - EdDSA signatures (Ed25519)
- `bbs.ts` - BBS+ signatures for selective disclosure
- No JSON Web Keys - uses multibase Multikey encoding

### Storage Abstraction (src/storage/)

Pluggable storage via StorageAdapter interface:
- `MemoryStorageAdapter` - In-memory (testing)
- `LocalStorageAdapter` - Browser localStorage
- Custom adapters can be implemented for databases, IPFS, etc.

### Migration System (src/migration/) — EXPERIMENTAL, not the production path

> **Note:** This subsystem is **experimental and unused in production.** `OriginalsSDK`/`LifecycleManager` run their own migrate/publish/inscribe flow with independent validation and never instantiate `MigrationManager`, so the checkpoint/rollback/audit/state-machine machinery below protects no production code path (issue #279). `MigrationManager` is intentionally **not** exported from the package entry point. Do not treat it as the supported migration API; use `LifecycleManager` (`sdk.lifecycle`) for real migrations.

State machine-driven asset migration with validation:
- **StateMachine (migration/state/StateMachine.ts)** - Enforces lifecycle rules
- **ValidationPipeline (migration/validation/)** - Pre-flight checks
  - DIDCompatibilityValidator: Ensures DID method compatibility
  - CredentialValidator: Validates credential integrity
  - StorageValidator: Checks storage requirements
  - LifecycleValidator: Enforces layer progression rules
- **CheckpointManager** - Creates recovery points
- **RollbackManager** - Reverts failed migrations

### Key Type System (src/types/)

**Multikey Encoding**
- All keys use multibase+multicodec encoding (not JWK)
- Supported types: ES256K (Bitcoin), Ed25519 (VC signing), ES256
- See src/crypto/Multikey.ts for encoding/decoding

**Bitcoin Types (bitcoin.ts)**
- UTXO, Transaction, Inscription interfaces
- Ordinals-specific types (satoshi ranges, inscription content)

**DID Types (did.ts)**
- W3C DID Document interfaces
- Verification methods, service endpoints
- ExternalSigner/ExternalVerifier interfaces

### Event System (src/events/)

**EventEmitter (EventEmitter.ts)** - Type-safe event dispatching
- Lifecycle events: asset:created, asset:migrated, resource:published
- Subscribe via `lifecycle.on(eventType, handler)`
- Event types defined in events/types.ts

## Important Implementation Patterns

### Error Handling
Use `StructuredError` from `src/utils/telemetry.ts` for consistent error reporting:
```typescript
throw new StructuredError('ERROR_CODE', 'User-friendly message');
```

### Validation
- Bitcoin addresses: Use `validateBitcoinAddress()` from utils/bitcoin-address.ts
- Satoshi numbers: Use `validateSatoshiNumber()` from utils/satoshi-validation.ts
- Never skip input validation - throw clear errors early

### Logging
- Logger instances available via config: `new Logger('ComponentName', config)`
- Supports multiple outputs and structured logging
- Sensitive data is sanitized when sanitizeLogs: true

### Testing Requirements
- All new features require unit tests in `tests/unit/`
- Bitcoin operations require integration tests with OrdMockProvider
- Complex flows need end-to-end tests in `tests/integration/`
- Security-sensitive code requires tests in `tests/security/`

## WebVH Network Deployments

The SDK supports three WebVH network deployments with different stability levels:

### Network Tiers

Each WebVH network maps to a corresponding Bitcoin network for consistent environment configuration across the entire stack:

- **`pichu.originals.build`** (Production)
  - **Stability**: Major releases only (X.0.0)
  - **Bitcoin Network**: `mainnet`
  - **Use case**: Production applications requiring maximum stability
  - **Default**: This is the default network

- **`cleffa.originals.build`** (Staging)
  - **Stability**: Minor releases (X.Y.0)
  - **Bitcoin Network**: `signet`
  - **Use case**: Pre-production testing and staging environments

- **`magby.originals.build`** (Development)
  - **Stability**: All patch versions (X.Y.Z)
  - **Bitcoin Network**: `regtest`
  - **Use case**: Development and experimentation with latest features

### Version Validation

Each network enforces semantic versioning constraints:
- **pichu**: Only accepts major releases (e.g., 1.0.0, 2.0.0)
- **cleffa**: Accepts major and minor releases (e.g., 1.1.0, 2.5.0)
- **magby**: Accepts all versions including patches (e.g., 1.2.3)

### Network Selection

You can select a network when configuring the SDK:

```typescript
// Use production network (default)
const sdk = OriginalsSDK.create({
  webvhNetwork: 'pichu', // or omit for default
});

// Use staging network
const sdk = OriginalsSDK.create({
  webvhNetwork: 'cleffa',
});

// Use development network
const sdk = OriginalsSDK.create({
  webvhNetwork: 'magby',
});
```

When creating or migrating to did:webvh, the SDK will automatically use the configured network's domain. You can also explicitly provide a domain to override:

```typescript
// Uses configured network domain (e.g., pichu.originals.build)
await sdk.did.createDIDWebVH({ paths: ['user', 'alice'] });

// Explicitly override domain
await sdk.did.createDIDWebVH({
  domain: 'custom.example.com',
  paths: ['user', 'alice']
});
```

### Context URLs

Each network has its own context URL:
- `https://pichu.originals.build/context`
- `https://cleffa.originals.build/context`
- `https://magby.originals.build/context`

All three networks use the same context document content, but are served from their respective domains.

### Bitcoin Network Mapping

When migrating assets from `did:webvh` to `did:btco`, the SDK automatically uses the Bitcoin network that corresponds to your configured WebVH network:

```typescript
const sdk = OriginalsSDK.create({
  webvhNetwork: 'magby', // Development network
});

// When migrating to did:btco, automatically uses Bitcoin regtest
await sdk.did.migrateToDIDBTCO(didDoc, satoshi);
// Creates: did:btco:reg:123 (regtest network)
```

The mapping ensures consistent environments:
- **magby** (dev) → **regtest** (Bitcoin dev network)
- **cleffa** (staging) → **signet** (Bitcoin test network)
- **pichu** (production) → **mainnet** (Bitcoin production)

This eliminates configuration errors and ensures that your development environment uses regtest, staging uses signet, and production uses mainnet automatically.

## Configuration

The SDK is configured via `OriginalsConfig`:

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet' | 'regtest' | 'signet', // Bitcoin network
  webvhNetwork: 'pichu' | 'cleffa' | 'magby', // WebVH network (default: 'pichu')
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256',
  ordinalsProvider: new OrdMockProvider(), // Required for Bitcoin ops
  feeOracle?: customFeeOracle, // Optional dynamic fees
  storageAdapter?: customStorage, // Optional custom storage
  enableLogging: true,
  logging?: { level, outputs, sanitizeLogs },
  telemetry?: customHooks
});
```

**Critical**: Bitcoin operations (inscribe, transfer) require `ordinalsProvider` to be configured. Use `OrdMockProvider` for testing, `QuickNodeProvider` for production reads/broadcast/status/fees (QuickNode Bitcoin endpoint with the Ordinals & Runes add-on; `createOrdinalsProviderFromEnv()` selects it when `QUICKNODE_ENDPOINT` is set). Inscription construction/signing stays local — QuickNodeProvider's `createInscription`/`transferInscription` fail loudly by design; build the transaction locally and submit via `broadcastTransaction`.

## Development Workflow

### When Adding New Features

1. **Create tests first** - Start with test cases in appropriate directory
2. **Implement incrementally** - Build in small, testable units
3. **Run tests continuously** - `bun test` should always pass
4. **Update types** - Keep interfaces in src/types/ current
5. **Document public APIs** - Add JSDoc comments for exported functions

### When Fixing Bugs

1. **Reproduce in test** - Create failing test case
2. **Identify root cause** - Use logging and debugging
3. **Fix with minimal changes** - Preserve existing behavior
4. **Verify fix** - Ensure test passes and no regressions
5. **Update related tests** - Adjust tests if behavior intentionally changed

### When Refactoring

1. **Ensure 100% test coverage** - All tests passing before refactor
2. **Refactor incrementally** - Small, atomic changes
3. **Run tests after each change** - Catch regressions immediately
4. **Preserve public APIs** - Don't break external consumers
5. **Update internal docs** - Keep CLAUDE.md current if architecture changes

## Cursor Rules Reference

This project uses Cursor AI rules in `.cursor/rules/` for development workflows:

- **@questions** - Enforce clarifying questions before code changes
- **@tasks** - Task list management for tracking PRD implementation
- **@continue** - Onboard fresh AI agents to projects in progress
- **@create-prd** - Guide creation of Product Requirements Documents

These rules ensure consistent collaboration patterns and prevent miscommunication during implementation.

## Common Gotchas

1. **Path imports**: Always use absolute imports from src/ root, not relative paths
2. **Noble crypto imports**: Use `@noble/hashes/sha2.js` not `@noble/hashes/sha256`
3. **Multikey encoding**: Never use JWK format - always multibase Multikey
4. **DID resolution**: Use DIDManager.resolveDID() not direct resolver calls
5. **Bitcoin operations**: Always validate satoshi numbers and addresses before operations
6. **Test setup**: Don't import setup.bun.ts manually - it's preloaded via bunfig.toml
7. **ExternalSigner**: For did:webvh operations, provide either keyPair OR externalSigner, not both

## Monorepo Structure

This is a monorepo with:
- `packages/sdk/` - The main SDK (where most development happens)
- `apps/` - Example applications (future)
- Root scripts in `scripts/` - CI/CD and coverage checks

Work primarily in `packages/sdk/` directory. Root-level commands delegate to SDK.
