# Originals Protocol - Documentation Index

Welcome to the Originals Protocol technical documentation. This index helps you navigate the complete specification suite.

## Quick Navigation

### 🚀 Getting Started
- **[README.md](README.md)** - Start here! Installation, quick start, and basic usage
- **[SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md)** - High-level overview (15 min read)
- **[examples/basic-usage.ts](src/examples/basic-usage.ts)** - Working code examples

### 📖 Complete Specifications
- **[TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md)** - Full technical specification (60 min read)
- **[BTCO DID Method](legacy/ordinalsplus/specs/btco-did-method.txt)** - DID method specification
- **[BTCO Linked Resources](legacy/ordinalsplus/specs/btco-did-linked-resources.txt)** - Resource addressing
- **[BTCO Verifiable Metadata](legacy/ordinalsplus/specs/btco-verifiable-metadata.txt)** - Credential specifications

### 🔧 Implementation Guides
- **[IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md)** - Implementation progress tracking
- **[package.json](package.json)** - Dependencies and build configuration
- **[tsconfig.json](tsconfig.json)** - TypeScript configuration

## Document Purpose Matrix

| Document | Audience | Purpose | When to Read |
|----------|----------|---------|--------------|
| README.md | Developers | Get started with SDK | First time using SDK |
| SPECIFICATION_SUMMARY.md | Architects, PMs | Understand system design | Planning phase |
| TECHNICAL_SPECIFICATION.md | Implementers | Build or audit system | Implementation phase |
| IMPLEMENTATION_CHECKLIST.md | Dev teams | Track progress | Development sprints |
| BTCO DID Method | DID experts | Understand did:btco | Deep dive on DIDs |
| BTCO Linked Resources | Integration teams | Resource addressing | Bitcoin integration |
| BTCO Verifiable Metadata | Credential devs | Credential formats | Credential work |

## Documentation Structure

```
/workspace/
├── README.md ⭐ START HERE
├── SPECIFICATION_INDEX.md (this file)
├── SPECIFICATION_SUMMARY.md
├── TECHNICAL_SPECIFICATION.md
├── IMPLEMENTATION_CHECKLIST.md
│
├── src/
│   ├── index.ts (SDK entry point)
│   ├── core/OriginalsSDK.ts (main class)
│   ├── did/ (DID operations)
│   ├── vc/ (credential operations)
│   ├── lifecycle/ (asset lifecycle)
│   ├── bitcoin/ (Bitcoin integration)
│   ├── types/ (TypeScript types)
│   └── examples/basic-usage.ts
│
├── tests/
│   ├── unit tests (by component)
│   └── integration tests (end-to-end)
│
└── legacy/ordinalsplus/specs/
    ├── btco-did-method.txt
    ├── btco-did-linked-resources.txt
    └── btco-verifiable-metadata.txt
```

## Reading Paths by Role

### 👨‍💻 Application Developer
1. [README.md](README.md) - Installation and quick start
2. [examples/basic-usage.ts](src/examples/basic-usage.ts) - Code examples
3. [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) - Understanding concepts
4. [API Documentation](#api-reference) - Detailed method documentation

**Time**: 30 minutes

### 🏗️ System Architect
1. [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) - System overview
2. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 3 - Architecture
3. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 6 - Data flows
4. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 9 - Security

**Time**: 2 hours

### 🔐 Security Auditor
1. [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) - Context
2. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 9 - Security considerations
3. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 7 - Error handling
4. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 2.3 - Credential verification
5. [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) § 9 - Known issues

**Time**: 3 hours

### 🎯 Product Manager
1. [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) - Full overview
2. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 1 - Executive overview
3. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 2 - Requirements
4. [Use Cases](#use-cases) - Real-world applications

**Time**: 1 hour

### 🛠️ Implementation Team
1. [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) - Overview
2. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 4 - Component specs
3. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 5 - Data models
4. [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) - Task tracking
5. [tests/](tests/) - Test suite as specification

**Time**: 4 hours + ongoing reference

### 🔬 Blockchain Integrator
1. [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) § Bitcoin Security
2. [BTCO DID Method](legacy/ordinalsplus/specs/btco-did-method.txt)
3. [BTCO Linked Resources](legacy/ordinalsplus/specs/btco-did-linked-resources.txt)
4. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 4.5 - BitcoinManager
5. [src/bitcoin/](src/bitcoin/) - Implementation code

**Time**: 3 hours

### 📝 Credential Specialist
1. [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) § Verifiable Credentials
2. [BTCO Verifiable Metadata](legacy/ordinalsplus/specs/btco-verifiable-metadata.txt)
3. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 2.3 - Credential specs
4. [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 4.3 - CredentialManager
5. [src/vc/](src/vc/) - Implementation code

**Time**: 2 hours

## Key Sections by Topic

### DID Operations
- **Summary**: [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) § "Three-Layer Architecture"
- **Complete**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 2.1 "Decentralized Identifiers"
- **Implementation**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 4.2 "DIDManager"
- **Code**: [src/did/DIDManager.ts](src/did/DIDManager.ts)

### Verifiable Credentials
- **Summary**: [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) § "Verifiable Credentials"
- **Complete**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 2.3 "Verifiable Credentials"
- **Implementation**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 4.3 "CredentialManager"
- **Whitepaper**: [BTCO Verifiable Metadata](legacy/ordinalsplus/specs/btco-verifiable-metadata.txt)
- **Code**: [src/vc/CredentialManager.ts](src/vc/CredentialManager.ts)

### Asset Lifecycle
- **Summary**: [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) § "Typical Workflow"
- **Complete**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 2.4 "Asset Lifecycle"
- **Workflows**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 6 "Data Flow & Workflows"
- **Implementation**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 4.4 "LifecycleManager"
- **Code**: [src/lifecycle/LifecycleManager.ts](src/lifecycle/LifecycleManager.ts)

### Bitcoin Integration
- **Summary**: [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) § "Bitcoin Security"
- **Complete**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 9.2 "Bitcoin-Specific Security"
- **Implementation**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 4.5 "BitcoinManager"
- **Whitepaper**: [BTCO DID Method](legacy/ordinalsplus/specs/btco-did-method.txt)
- **Code**: [src/bitcoin/BitcoinManager.ts](src/bitcoin/BitcoinManager.ts)

### Security
- **Summary**: [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) § "Security Features"
- **Complete**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 9 "Security Considerations"
- **Bitcoin**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 9.2
- **Credentials**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 9.4
- **Known Issues**: [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) § 9

### Data Models
- **Summary**: [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) § "Data Models"
- **Complete**: [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) § 5 "Data Models"
- **Types**: [src/types/](src/types/)

## API Reference

### Main SDK
```typescript
OriginalsSDK.create(config?: Partial<OriginalsConfig>): OriginalsSDK
```
**Docs**: [TECHNICAL_SPECIFICATION.md § 4.1](TECHNICAL_SPECIFICATION.md#41-originalssdk)

### DID Operations
```typescript
DIDManager.createDIDPeer(resources): Promise<DIDDocument>
DIDManager.migrateToDIDWebVH(didDoc, domain): Promise<DIDDocument>
DIDManager.migrateToDIDBTCO(didDoc, satoshi): Promise<DIDDocument>
DIDManager.resolveDID(did): Promise<DIDDocument | null>
```
**Docs**: [TECHNICAL_SPECIFICATION.md § 4.2](TECHNICAL_SPECIFICATION.md#42-didmanager)

### Credential Operations
```typescript
CredentialManager.createResourceCredential(type, subject, issuer): Promise<VerifiableCredential>
CredentialManager.signCredential(credential, privateKey, vm): Promise<VerifiableCredential>
CredentialManager.verifyCredential(credential): Promise<boolean>
CredentialManager.createPresentation(credentials, holder): Promise<VerifiablePresentation>
```
**Docs**: [TECHNICAL_SPECIFICATION.md § 4.3](TECHNICAL_SPECIFICATION.md#43-credentialmanager)

### Lifecycle Operations
```typescript
LifecycleManager.createAsset(resources): Promise<OriginalsAsset>
LifecycleManager.publishToWeb(asset, domain): Promise<OriginalsAsset>
LifecycleManager.inscribeOnBitcoin(asset, feeRate?): Promise<OriginalsAsset>
LifecycleManager.transferOwnership(asset, newOwner): Promise<BitcoinTransaction>
```
**Docs**: [TECHNICAL_SPECIFICATION.md § 4.4](TECHNICAL_SPECIFICATION.md#44-lifecyclemanager)

### Bitcoin Operations
```typescript
BitcoinManager.inscribeData(data, contentType, feeRate?): Promise<OrdinalsInscription>
BitcoinManager.trackInscription(inscriptionId): Promise<OrdinalsInscription | null>
BitcoinManager.transferInscription(inscription, toAddress): Promise<BitcoinTransaction>
BitcoinManager.preventFrontRunning(satoshi): Promise<boolean>
BitcoinManager.validateBTCODID(didId): Promise<boolean>
```
**Docs**: [TECHNICAL_SPECIFICATION.md § 4.5](TECHNICAL_SPECIFICATION.md#45-bitcoinmanager)

### Asset Operations
```typescript
OriginalsAsset.migrate(toLayer, details?): Promise<void>
OriginalsAsset.getProvenance(): ProvenanceChain
OriginalsAsset.recordTransfer(from, to, txId): void
OriginalsAsset.verify(deps?): Promise<boolean>
```
**Docs**: [TECHNICAL_SPECIFICATION.md § 4.7](TECHNICAL_SPECIFICATION.md#47-originalsasset)

## Use Cases

### Digital Art
**Reference**: [SPECIFICATION_SUMMARY.md § Use Cases](SPECIFICATION_SUMMARY.md#use-cases)

**Example**: [examples/basic-usage.ts § digitalArtExample](src/examples/basic-usage.ts)

**Flow**: Create (peer) → Publish (webvh) → Inscribe on sale (btco) → Transfer to collector

### Scientific Data
**Reference**: [README.md § Use Cases](README.md#use-cases)

**Flow**: Document dataset (peer) → Publish preprint (webvh) → Anchor publication (btco)

### Supply Chain
**Reference**: [README.md § Use Cases](README.md#use-cases)

**Flow**: Production record (peer) → Public registry (webvh) → Ownership transfer (btco)

### DAO Governance
**Reference**: [README.md § Use Cases](README.md#use-cases)

**Flow**: Proposal (peer) → Vote (webvh) → Execute decision (btco)

## Whitepaper vs Implementation

### Whitepaper Specifications
Located in `legacy/ordinalsplus/specs/`:

1. **BTCO DID Method (v0.2.0)**
   - File: `btco-did-method.txt`
   - Status: Fully implemented ✅
   - Notes: Supports both v0.1 and v0.2 deactivation formats

2. **BTCO DID Linked Resources (v0.2.0)**
   - File: `btco-did-linked-resources.txt`
   - Status: Core features implemented ✅
   - Partial: Collection resolution not in SDK ⚠️

3. **BTCO Verifiable Metadata (v0.2.0)**
   - File: `btco-verifiable-metadata.txt`
   - Status: Core features implemented ✅
   - Partial: Status lists not implemented ⚠️

### Implementation Deviations
See [IMPLEMENTATION_CHECKLIST.md § 9](IMPLEMENTATION_CHECKLIST.md#phase-9-known-issues--todos) for details:
- ES256 key support (fallback to Ed25519)
- Credential status lists (specified but not implemented)
- Collection resolution (manual via OrdinalsClient)
- BBS+ selective disclosure (partial)

## Testing Documentation

### Test Structure
- **Unit Tests**: `tests/` organized by component
- **Integration Tests**: `tests/integration/`
- **Test Coverage**: ~85% (see `badges/coverage.svg`)

### Key Test Files
- `tests/did/DIDManager.test.ts` - DID operations
- `tests/vc/` - Credential operations
- `tests/lifecycle/LifecycleManager.test.ts` - Lifecycle
- `tests/bitcoin/BitcoinManager.test.ts` - Bitcoin integration

### Running Tests
```bash
bun test                # Run all tests
bun test:coverage      # Run with coverage
bun test:ci            # CI mode with coverage
```

## Version History

| Version | Date | Document | Changes |
|---------|------|----------|---------|
| 1.0.0 | 2025-09-30 | All | Initial comprehensive specification |
| 0.2.0 | 2024-03-21 | Whitepapers | BTCO spec updates |
| 0.1.0 | 2024-02-18 | Whitepapers | Initial whitepaper versions |

## External References

### W3C Standards
- [DID Core v1](https://www.w3.org/TR/did-core/)
- [Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
- [Data Integrity](https://www.w3.org/TR/vc-data-integrity/)

### DID Methods
- [DID Peer Method](https://identity.foundation/peer-did-method-spec/)
- [DID WebVH](https://github.com/transmute-industries/did-webvh)

### Bitcoin & Ordinals
- [Bitcoin Ordinals](https://docs.ordinals.com/)
- [Ord Documentation](https://docs.ordinals.com/guides/inscriptions.html)

### Cryptography
- [Multibase](https://github.com/multiformats/multibase)
- [Multicodec](https://github.com/multiformats/multicodec)

## Contributing

For contribution guidelines, see the main README.md.

For bug reports or feature requests related to specifications:
1. Check [IMPLEMENTATION_CHECKLIST.md § 9](IMPLEMENTATION_CHECKLIST.md#phase-9-known-issues--todos) for known issues
2. Review [TECHNICAL_SPECIFICATION.md § 11](TECHNICAL_SPECIFICATION.md#11-open-questions) for open questions
3. File issues with references to specific specification sections

## Support

- **Questions**: File an issue with `[question]` tag
- **Bug Reports**: File an issue with reproduction steps
- **Security Issues**: See security policy in README.md

## License

MIT License - see LICENSE file for details

---

**Navigation Tips**:
- Use your editor's search function to find specific topics across all documents
- Specification sections are numbered for easy cross-referencing
- Code examples link back to specification sections
- All TypeScript types are documented in `src/types/`

**Last Updated**: 2025-09-30  
**Maintained By**: Originals Team
