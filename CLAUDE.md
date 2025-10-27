# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
  getVerificationMethodId(): Promise<string> | string;
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

**LifecycleManager (LifecycleManager.ts)** - Orchestrates asset migration
- `createAsset()` - Creates did:peer asset with resources
- `publishToWeb()` - Migrates to did:webvh
- `inscribeOnBitcoin()` - Migrates to did:btco
- Event-driven architecture via EventEmitter
- Batch operations support for multiple assets

**OriginalsAsset (OriginalsAsset.ts)** - Asset representation
- Encapsulates resources, credentials, and provenance
- Tracks migration state across layers
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

### Migration System (src/migration/)

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
- Lifecycle events: asset.created, asset.migrated, resource.published
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

## Configuration

The SDK is configured via `OriginalsConfig`:

```typescript
const sdk = OriginalsSDK.create({
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet',
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256',
  ordinalsProvider: new OrdMockProvider(), // Required for Bitcoin ops
  feeOracle?: customFeeOracle, // Optional dynamic fees
  storageAdapter?: customStorage, // Optional custom storage
  enableLogging: true,
  logging?: { level, outputs, sanitizeLogs },
  telemetry?: customHooks
});
```

**Critical**: Bitcoin operations (inscribe, transfer) require `ordinalsProvider` to be configured. Use `OrdMockProvider` for testing, `OrdinalsClient` for production.

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
