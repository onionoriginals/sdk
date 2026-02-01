# Originals SDK v1.0 Release Notes

**Release Date:** 2026-01-30  
**Status:** Stable Release

---

## 🎉 What's New in v1.0

The Originals SDK v1.0 is the first stable release of the digital authenticity protocol implementation. This release provides complete support for creating, publishing, and verifying digital originals across three trust layers.

### Three DID Layers Fully Implemented

| Layer | DID Method | Use Case | Cost |
|-------|------------|----------|------|
| **Private** | `did:peer` | Local development, testing | Free |
| **Public Web** | `did:webvh` | Web publication, verification | ~$25/year |
| **Bitcoin** | `did:btco` | Permanent inscription, maximum trust | $75-200+ |

### Complete Verifiable Credential Support

- **ResourceCredential**: Digital asset authenticity attestation
- **OriginCredential**: Provenance and creation evidence
- **TransferCredential**: Ownership transfer documentation
- **MigrationCredential**: Cross-layer migration proof
- **EdDSA Cryptosuite**: Ed25519 signatures with Data Integrity proofs

### Bitcoin Ordinals Integration

- Inscription of assets up to 4MB
- Batch operations with 30%+ cost optimization
- Support for mainnet, testnet, and signet
- External signer integration (Turnkey, AWS KMS)
- Fee estimation and optimization

### Migration State Machine

- Automatic state tracking across layers
- Recovery from interrupted migrations
- Dual attestation for trust preservation
- Complete audit trail with SHA-256 hashes

### Comprehensive Test Suite

- 1983 tests across 103 files
- Unit, integration, and security tests
- All three networks covered
- <25 second full test run

---

## 📦 Installation

```bash
# npm
npm install @AviaryTech/originals-sdk

# bun
bun add @AviaryTech/originals-sdk

# pnpm
pnpm add @AviaryTech/originals-sdk
```

---

## 🚀 Quick Start

```typescript
import { OriginalsSDK } from '@AviaryTech/originals-sdk';

// Initialize SDK
const sdk = await OriginalsSDK.create({
  network: 'testnet',
  storage: './originals-data'
});

// Create a digital original
const asset = await sdk.lifecycle.createAsset({
  content: myImage,
  contentType: 'image/png',
  title: 'My Digital Original',
  creator: 'did:peer:2...'
});

// Publish to web
await sdk.lifecycle.publishToWeb(asset, {
  domain: 'example.com'
});

// Inscribe on Bitcoin (permanent)
await sdk.lifecycle.inscribeOnBitcoin(asset, {
  feeRate: 10 // sat/vB
});
```

---

## ⚠️ Known Limitations

These limitations are documented and will be addressed in v1.1:

1. **Audit Trail**: Uses SHA-256 hashes; digital signatures coming in v1.1
2. **HTTP Provider**: Basic timeout handling; circuit breaker in v1.1
3. **Metrics**: Event-based only; Prometheus export in v1.1

---

## 🔒 Security Notes

- **External Signers**: Use Turnkey or AWS KMS for production key management
- **Input Validation**: Comprehensive validation on all API boundaries
- **Bitcoin Safety**: Address checksums and network validation enforced
- **Key Rotation**: Built-in support with automatic recovery

See [SECURITY.md](./SECURITY.md) for full security documentation.

---

## 📊 Performance

| Operation | Typical Latency |
|-----------|-----------------|
| DID Resolution (cached) | <100ms |
| DID Resolution (network) | <1s |
| Credential Verification | <10ms |
| Batch Inscription | 30%+ cost savings |
| Large Asset (4MB) | Supported |

---

## 🔜 What's Next (v1.1)

- **Audit Trail Signatures**: EdDSA signatures on all audit records
- **Circuit Breaker**: Resilient HTTP provider with automatic recovery
- **Observable Metrics**: Prometheus/OpenTelemetry export
- **DID Caching**: Local cache for faster resolution

---

## 🙏 Acknowledgments

- The W3C DID and Verifiable Credentials working groups
- The Ordinals/Inscriptions community
- All contributors and early testers

---

## 📚 Documentation

- [API Reference](./API_REFERENCE.md)
- [Bitcoin Integration Guide](./BITCOIN_INTEGRATION_GUIDE.md)
- [Key Rotation Guide](./KEY_ROTATION_GUIDE.md)
- [LLM Agent Guide](./LLM_AGENT_GUIDE.md)
- [Specification](./ORIGINALS_SPECIFICATION_v1.0.md)

---

## 🐛 Bug Reports

Please report issues at: https://github.com/AviaryTech/originals-sdk/issues

---

**Full Changelog:** https://github.com/AviaryTech/originals-sdk/compare/v0.9.0...v1.0.0
