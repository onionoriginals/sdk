# Originals Protocol - Specification Suite

**Complete Technical Documentation for Implementation and Audit**

---

## 📚 What You'll Find Here

This specification suite provides everything needed to understand, implement, audit, or extend the Originals Protocol:

- ✅ **Complete Technical Specification** (13,000+ words)
- ✅ **Implementation Checklist** (phase-by-phase tracking)
- ✅ **Executive Summary** (15-minute overview)
- ✅ **Documentation Index** (navigation guide)
- ✅ **Working Codebase** (TypeScript SDK with 85% test coverage)
- ✅ **Whitepaper References** (BTCO DID specifications)

## 🎯 Start Here Based on Your Role

### 👨‍💻 I Want to Use the SDK
**Start with**: [`README.md`](README.md)

Quick install and usage:
```bash
npm install @originals/sdk
```

```typescript
import { OriginalsSDK } from '@originals/sdk';

const sdk = OriginalsSDK.create({ network: 'testnet' });
const asset = await sdk.lifecycle.createAsset(resources);
await sdk.lifecycle.publishToWeb(asset, 'example.com');
await sdk.lifecycle.inscribeOnBitcoin(asset);
```

**Time to first success**: 10 minutes

---

### 🏗️ I Want to Understand the System Design
**Start with**: [`SPECIFICATION_SUMMARY.md`](SPECIFICATION_SUMMARY.md)

High-level overview covering:
- Three-layer architecture (peer → webvh → btco)
- Economic gravity model
- Core components and data flow
- Use cases and examples

**Reading time**: 15 minutes

---

### 🔧 I Want to Implement or Audit the System
**Start with**: [`TECHNICAL_SPECIFICATION.md`](TECHNICAL_SPECIFICATION.md)

Comprehensive specification including:
- Complete requirements and constraints
- Architecture diagrams and component specs
- API specifications with signatures
- Data models and workflows
- Error handling and security
- Testing criteria and validation

**Reading time**: 60 minutes
**Reference use**: Ongoing

---

### ✅ I Want to Track Implementation Progress
**Start with**: [`IMPLEMENTATION_CHECKLIST.md`](IMPLEMENTATION_CHECKLIST.md)

Detailed checklist covering:
- 10 implementation phases
- Task-level completion tracking
- Known issues and workarounds
- Production readiness criteria

**Current Status**: 90% complete

---

### 🧭 I Need Help Navigating
**Start with**: [`SPECIFICATION_INDEX.md`](SPECIFICATION_INDEX.md)

Complete navigation guide:
- Reading paths by role
- Quick reference to key sections
- API reference with links
- Use case examples

---

## 📖 Complete Document List

### Core Specification Documents
| Document | Size | Purpose | Audience |
|----------|------|---------|----------|
| **TECHNICAL_SPECIFICATION.md** | 13,000 words | Complete technical spec | Implementers, auditors |
| **SPECIFICATION_SUMMARY.md** | 4,000 words | High-level overview | Architects, PMs |
| **IMPLEMENTATION_CHECKLIST.md** | 3,000 words | Implementation tracking | Dev teams |
| **SPECIFICATION_INDEX.md** | 2,000 words | Navigation guide | All roles |

### Supporting Documents
| Document | Purpose |
|----------|---------|
| **README.md** | SDK usage and quick start |
| **SPECIFICATION_README.md** | This document - specification suite intro |
| **package.json** | Dependencies and build config |
| **tsconfig.json** | TypeScript configuration |

### Whitepaper Specifications
| Document | Version | Status |
|----------|---------|--------|
| **btco-did-method.txt** | v0.2.0 | Implemented ✅ |
| **btco-did-linked-resources.txt** | v0.2.0 | Core implemented ✅ |
| **btco-verifiable-metadata.txt** | v0.2.0 | Core implemented ✅ |

## 🔑 Key Concepts

### Three-Layer Architecture

The Originals Protocol implements economic layer separation:

```
┌─────────────────────────────────────────────────────────────┐
│ LAYER 1: did:peer (Creation)                                 │
│ Cost: Free | Security: High (self-contained)                 │
│ Purpose: Private experimentation                             │
└─────────────────────┬───────────────────────────────────────┘
                      │ Migration
                      ↓
┌─────────────────────────────────────────────────────────────┐
│ LAYER 2: did:webvh (Discovery)                               │
│ Cost: ~$25/year | Security: Medium (HTTPS)                   │
│ Purpose: Public discovery and sharing                        │
└─────────────────────┬───────────────────────────────────────┘
                      │ Migration
                      ↓
┌─────────────────────────────────────────────────────────────┐
│ LAYER 3: did:btco (Ownership)                                │
│ Cost: $75-200 one-time | Security: Maximum (Bitcoin)         │
│ Purpose: Transferable ownership, permanent record            │
└─────────────────────────────────────────────────────────────┘
```

**Key Principle**: Assets start cheap and migrate to Bitcoin only when economic value justifies security costs.

### Unidirectional Migration

Assets can only move forward through layers:
- ✅ `did:peer` → `did:webvh`
- ✅ `did:webvh` → `did:btco`
- ✅ `did:peer` → `did:btco` (skip webvh)
- ❌ Any backward migration (not allowed)

**Rationale**: Once committed to higher security, downgrading would undermine trust.

### Cryptographic Provenance

Every asset maintains complete, verifiable history:
- Creator identity (DID)
- All layer migrations (with timestamps and transaction IDs)
- All ownership transfers (Bitcoin transactions)
- Cryptographic proofs for all operations

**Verification**: Anyone can verify the complete provenance chain at any time.

## 🎯 What Problem Does This Solve?

### The Problem
Traditional digital asset systems force an all-or-nothing choice:
- **Centralized platforms**: Cheap but risky (platform can disappear)
- **Blockchain-only**: Secure but expensive ($150+ per asset)

This makes experimentation prohibitively expensive and forces creators to commit to blockchain before knowing if assets have value.

### The Solution
Originals Protocol enables economic gravity:
1. **Create freely**: Start with did:peer (free, private)
2. **Share cheaply**: Publish to did:webvh ($25/year for unlimited assets)
3. **Secure selectively**: Inscribe to did:btco only when value justifies cost

**Result**: Creators can experiment with 1000 assets for free, publish 100 for $25/year, and inscribe only the 10 that sell for $150 each.

## 📊 Implementation Status

### Overall: 90% Complete ✅

#### ✅ Fully Implemented
- Three-layer DID creation and migration
- Asset lifecycle management
- Verifiable credential issuance and verification
- Bitcoin inscription via ordinals
- Complete provenance tracking
- Resource integrity verification
- Comprehensive test suite (85% coverage)

#### ⚠️ Partially Implemented
- ES256 key support (fallback to Ed25519)
- BBS+ selective disclosure (basic implementation)
- Collection resolution (manual via OrdinalsClient)

#### 📋 Specified but Not Implemented
- Credential status lists
- Heritage collection traversal
- Curated collection resolution
- Batch inscription operations

### Production Readiness: 40% ⚠️

**Remaining work**:
- [ ] Credential status list implementation
- [ ] Production monitoring setup
- [ ] Key management documentation
- [ ] DID resolution caching
- [ ] Security audit

**See**: [IMPLEMENTATION_CHECKLIST.md § 10](IMPLEMENTATION_CHECKLIST.md#phase-10-production-readiness)

## 🔒 Security Highlights

### Bitcoin Security
- **Front-running prevention**: Ordinal theory ensures unique satoshi assignment
- **Immutable storage**: Inscriptions cannot be deleted or modified
- **UTXO-based control**: Ownership tied to Bitcoin keys
- **6-confirmation finality**: Recommended for high-value assets

### Cryptographic Security
- **Multiple key types**: Ed25519, secp256k1, P-256, BLS12-381 G2
- **Data Integrity proofs**: W3C standard, no JWT
- **Multikey encoding**: Future-proof, algorithm-agile
- **SHA-256 hashing**: Resource integrity verification

### Key Management
- **Secure generation**: Cryptographically secure random number generator
- **HSM support**: Guidelines for hardware security modules
- **Key rotation**: Supported at each layer via DID updates
- **No network transmission**: Private keys never leave local system

**See**: [TECHNICAL_SPECIFICATION.md § 9](TECHNICAL_SPECIFICATION.md#9-security-considerations)

## 🧪 Testing

### Test Coverage: 85% ✅

Comprehensive test suite covering:
- **Unit tests**: All core components (100+ tests per component)
- **Integration tests**: End-to-end workflows
- **Provider tests**: Mock and real Bitcoin providers
- **Security tests**: Key generation, signature verification, tamper detection

### Running Tests
```bash
bun test              # Run all tests
bun test:coverage     # Generate coverage report
bun test:ci           # CI mode with coverage badge
```

### Test-Driven Specification
Tests serve as executable specifications:
- Each workflow tested end-to-end
- Edge cases documented in test names
- Error conditions validated
- Performance benchmarks included

**See**: [TECHNICAL_SPECIFICATION.md § 8](TECHNICAL_SPECIFICATION.md#8-testing--validation)

## 🌟 Standards Compliance

### W3C Standards ✅
- **DID Core v1**: Full compliance
- **Verifiable Credentials Data Model 2.0**: Full compliance
- **Data Integrity**: eddsa-rdfc-2022 cryptosuite

### DID Methods ✅
- **did:peer**: Using @aviarytech/did-peer (numalgo4)
- **did:webvh**: Using didwebvh-ts library
- **did:btco**: Custom implementation per v0.2.0 spec

### No Proprietary Formats ✅
- No JSON Web Keys (uses Multikey)
- No JWT (uses Data Integrity proofs)
- No custom cryptography (uses Noble libraries)
- No vendor lock-in

## 📝 Use Case Examples

### Digital Art Lifecycle
```typescript
// Artist creates artwork (free)
const asset = await sdk.lifecycle.createAsset([artwork]);
// Layer: did:peer, Cost: $0

// Publish to portfolio (cheap)
await sdk.lifecycle.publishToWeb(asset, 'artist-gallery.com');
// Layer: did:webvh, Cost: $25/year

// Buyer purchases artwork (secure)
await sdk.lifecycle.inscribeOnBitcoin(asset);
// Layer: did:btco, Cost: $150

// Transfer to buyer (final)
await sdk.lifecycle.transferOwnership(asset, buyerAddress);
// Ownership: Buyer, Cost: $5 transfer fee
```

**Total cost**: $180 for sold artwork, $0 for unsold sketches

### Scientific Data Publication
```typescript
// Researcher documents dataset (private)
const dataset = await sdk.lifecycle.createAsset([dataResources]);
// Private research phase

// Publish preprint (discoverable)
await sdk.lifecycle.publishToWeb(dataset, 'research-lab.edu');
// Peer review phase

// Anchor publication (permanent)
await sdk.lifecycle.inscribeOnBitcoin(dataset);
// Permanent scientific record
```

**Total cost**: $175 for published paper, $0 for exploratory research

## 🚀 Getting Started Paths

### Path 1: Quick Experiment (5 minutes)
```bash
npm install @originals/sdk
```

```typescript
import { OriginalsSDK } from '@originals/sdk';
const sdk = OriginalsSDK.create({ network: 'testnet' });
const asset = await sdk.lifecycle.createAsset([{
  id: 'test-1',
  type: 'text',
  contentType: 'text/plain',
  hash: 'abc123',
  content: 'Hello, Originals!'
}]);
console.log('Created:', asset.id);
```

### Path 2: Understand Design (15 minutes)
1. Read [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md)
2. Review architecture diagrams
3. Understand three-layer model

### Path 3: Implement Feature (2 hours)
1. Read [TECHNICAL_SPECIFICATION.md § 4](TECHNICAL_SPECIFICATION.md#4-component--api-specifications) for component specs
2. Review [src/](src/) implementation
3. Check [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) for status
4. Write tests following existing patterns

### Path 4: Security Audit (4 hours)
1. Read [TECHNICAL_SPECIFICATION.md § 9](TECHNICAL_SPECIFICATION.md#9-security-considerations)
2. Review [IMPLEMENTATION_CHECKLIST.md § 9](IMPLEMENTATION_CHECKLIST.md#phase-9-known-issues--todos)
3. Audit key management in [src/crypto/](src/crypto/)
4. Review Bitcoin integration in [src/bitcoin/](src/bitcoin/)

## 🤝 Contributing

### Documentation Improvements
- Found unclear sections? File an issue with suggestions
- Want to add examples? Submit a PR with new use cases
- Spotted errors? File an issue with corrections

### Implementation Contributions
- Check [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) for open tasks
- Review [TECHNICAL_SPECIFICATION.md § 11](TECHNICAL_SPECIFICATION.md#11-open-questions) for design questions
- Follow existing code patterns and test coverage standards

### Specification Clarifications
- Open questions documented in [TECHNICAL_SPECIFICATION.md § 11](TECHNICAL_SPECIFICATION.md#11-open-questions)
- Known ambiguities tracked in [IMPLEMENTATION_CHECKLIST.md § 9](IMPLEMENTATION_CHECKLIST.md#phase-9-known-issues--todos)
- Submit issues referencing specific specification sections

## 📞 Support

### Questions
- **General questions**: File issue with `[question]` tag
- **Specification clarifications**: Reference section numbers in issues
- **Implementation help**: Include code snippets and error messages

### Bug Reports
- **Security issues**: Follow security policy in README.md
- **Functional bugs**: Include reproduction steps and test failures
- **Documentation bugs**: Reference specific sections with suggested fixes

### Feature Requests
- Check [TECHNICAL_SPECIFICATION.md § 11.4](TECHNICAL_SPECIFICATION.md#114-future-enhancements)
- Review [IMPLEMENTATION_CHECKLIST.md § 9](IMPLEMENTATION_CHECKLIST.md#phase-9-known-issues--todos)
- Submit with use case justification

## 📄 License

MIT License - See LICENSE file for details

Copyright (c) 2025 Aviary Tech

## 🙏 Acknowledgments

### Standards
- W3C for DID and Verifiable Credentials standards
- Decentralized Identity Foundation for DID methods
- Bitcoin Core and Ordinals communities

### Libraries
- @aviarytech/did-peer for DID Peer implementation
- didwebvh-ts for DID WebVH implementation
- Noble libraries for cryptographic primitives
- bitcoinjs-lib for Bitcoin transactions

### Inspiration
- Bitcoin's Ordinals protocol for immutable inscription
- W3C's vision for decentralized identity
- The maker community's need for affordable provenance

---

## 🗺️ Quick Navigation

| I want to... | Go to... |
|--------------|----------|
| Use the SDK | [README.md](README.md) |
| Understand the design | [SPECIFICATION_SUMMARY.md](SPECIFICATION_SUMMARY.md) |
| Implement a feature | [TECHNICAL_SPECIFICATION.md](TECHNICAL_SPECIFICATION.md) |
| Track progress | [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) |
| Navigate docs | [SPECIFICATION_INDEX.md](SPECIFICATION_INDEX.md) |
| Run examples | [src/examples/basic-usage.ts](src/examples/basic-usage.ts) |
| Review code | [src/](src/) |
| Run tests | `bun test` |

---

**Last Updated**: 2025-09-30  
**Specification Version**: 1.0.0  
**Implementation Version**: 1.0.0  
**Maintained By**: Originals Team

**Status**: ✅ Specification Complete | 🔄 Production Hardening In Progress
