# Originals SDK Release Notes

## Current Version: 1.8.3

> The Originals SDK enables creation, discovery, and transfer of digital assets with cryptographically verifiable provenance using the three-layer Originals Protocol.

---

## 🎉 What's in the SDK

### Three-Layer DID Architecture

| Layer | DID Method | Cost | Purpose |
|-------|-----------|------|---------|
| **Private** | `did:peer` | $0 | Offline creation and experimentation |
| **Public** | `did:webvh` | ~$25/year | Web discovery via HTTPS hosting |
| **Bitcoin** | `did:btco` | $75-200 | Permanent, transferable ownership |

Assets migrate unidirectionally: `did:peer` → `did:webvh` → `did:btco`

### Core Features

#### ✅ DID Management
- **did:peer** - Create offline DIDs for private experimentation
- **did:webvh** - Publish DIDs for web discovery with version history
- **did:btco** - Inscribe DIDs on Bitcoin for permanent ownership
- Universal DID resolution across all methods
- External signer support (Turnkey, AWS KMS, HSMs)

#### ✅ Verifiable Credentials
- W3C VC Data Model 2.0 compliant
- JSON-LD credential signing (no JWT)
- Data Integrity proofs with multiple cryptosuites:
  - `eddsa-rdfc-2022` (EdDSA - recommended)
  - `bbs-2023` (BBS+ for selective disclosure)
- Credential verification and presentation

#### ✅ Asset Lifecycle
- Create digital assets with associated resources
- Migrate assets between protocol layers
- Event-driven architecture for tracking migrations
- Batch operations with 30%+ cost optimization

#### ✅ Bitcoin/Ordinals Integration
- Commit-reveal pattern for front-running protection
- Ordinals inscription support
- Inscription transfers for ownership changes
- Fee estimation and management
- Support for mainnet, testnet, signet, and regtest

#### ✅ Authentication Package (@originals/auth)
- Turnkey integration for key management
- Email-based OTP authentication
- JWT token handling
- Server and client components

### WebVH Network Deployments

| Network | Bitcoin | Stability | Use Case |
|---------|---------|-----------|----------|
| `pichu` (default) | mainnet | Major releases | Production |
| `cleffa` | signet | Minor releases | Staging |
| `magby` | regtest | All versions | Development |

---

## 📦 Installation

```bash
npm install @originals/sdk
# or
bun add @originals/sdk
```

## 🚀 Quick Start

```typescript
import { OriginalsSDK, OrdMockProvider } from '@originals/sdk';

// Create SDK instance
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  webvhNetwork: 'pichu',
  ordinalsProvider: new OrdMockProvider(), // Use real provider in production
});

// Create a private asset (did:peer)
const asset = await sdk.lifecycle.createAsset([{
  id: 'my-artwork',
  type: 'image',
  contentType: 'image/png',
  hash: 'sha256-...'
}]);

// Publish for discovery (did:webvh)
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');

// Inscribe on Bitcoin (did:btco)
const inscribed = await sdk.lifecycle.inscribeOnBitcoin(published);
```

---

## 📊 Test Coverage

- **1,980+ tests** across 103 files
- Unit, integration, security, and stress tests
- All three DID methods tested
- Bitcoin operations tested with mock provider

---

## 🔒 Security Features

- Input validation on all boundaries
- Bitcoin address validation (checksum + network)
- Satoshi number validation (0 to 2099999997689999)
- Fee bounds enforced (1-10,000 sat/vB)
- Private keys never logged
- Commit-reveal pattern prevents front-running

---

## 📚 Documentation

- [README.md](./README.md) - Getting started guide
- [CLAUDE.md](./CLAUDE.md) - Development guide for AI/LLM agents
- [docs/API_REFERENCE.md](./docs/API_REFERENCE.md) - Complete API documentation
- [docs/LLM_AGENT_GUIDE.md](./docs/LLM_AGENT_GUIDE.md) - LLM-optimized reference
- [ORIGINALS_SPECIFICATION_v1.0.md](./ORIGINALS_SPECIFICATION_v1.0.md) - Protocol specification

---

## ⚠️ Known Limitations

1. **AuditLogger** - Uses SHA-256 hashes; digital signatures planned for v2.0
2. **HTTP Provider** - Basic timeout handling; circuit breaker pattern planned
3. **Real Bitcoin Testing** - Thoroughly tested with mock provider; production Bitcoin testing recommended before mainnet deployment

---

## 🗺️ Roadmap

### v2.0 (Planned)
- [ ] Audit trail digital signatures
- [ ] Circuit breaker for HTTP provider
- [ ] Observable metrics and telemetry
- [ ] Enhanced batch operation strategies

---

## 🙏 Acknowledgments

Built on:
- [W3C DID Core](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials](https://www.w3.org/TR/vc-data-model-2.0/)
- [Bitcoin Ordinals Protocol](https://docs.ordinals.com/)
- [didwebvh-ts](https://github.com/decentralized-identity/didwebvh-ts)

---

## 📄 License

MIT License - see [LICENSE](./LICENSE) file for details.

---

*Created by Brian Richter (Aviary Tech) and contributors*
*Documentation contributions by Krusty 🦞🤡*
