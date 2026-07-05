# @originals/sdk

TypeScript SDK for the **Originals Protocol** — create, discover, and transfer digital assets with cryptographically verifiable provenance.

The protocol organizes a digital asset's lifecycle into three layers, and assets migrate unidirectionally through them:

| Layer | Purpose | Cost |
|-------|---------|------|
| `did:peer` | Private creation and experimentation (offline) | Free |
| `did:webvh` | Public discovery via HTTPS hosting | Hosting only |
| `did:btco` | Transferable ownership on Bitcoin (Ordinals) | Bitcoin fees |

## Installation

```bash
npm install @originals/sdk
# or
bun add @originals/sdk
```

Requires Node.js `>=20.10.0` (or Bun). Published as ESM.

## Quick start

```typescript
import { OriginalsSDK } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'mainnet',          // 'mainnet' | 'signet' | 'regtest'
  defaultKeyType: 'ES256K',    // 'ES256K' | 'Ed25519' | 'ES256'
});

// 1. Create an asset privately (did:peer — offline, free)
const asset = await sdk.lifecycle.createAsset([
  {
    id: 'artwork-1',
    type: 'image',
    contentType: 'image/png',
    hash: '<sha256-hex-of-content>',
  },
]);

// 2. Publish it for discovery (did:webvh)
const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');

// 3. Inscribe it on Bitcoin for transferable ownership (did:btco)
//    Requires an ordinalsProvider in the SDK config.
const inscribed = await sdk.lifecycle.inscribeOnBitcoin(published);
```

Bitcoin operations (inscribe, transfer) require an `ordinalsProvider` in the config — use `OrdMockProvider` for development and testing, `OrdinalsClient` for production.

## Documentation

- [LLM Agent Guide](https://github.com/onionoriginals/sdk/blob/main/docs/LLM_AGENT_GUIDE.md) — full API reference with signatures, types, and examples
- [Quick Reference](https://github.com/onionoriginals/sdk/blob/main/docs/LLM_QUICK_REFERENCE.md) — compact quick-reference card
- [Repository](https://github.com/onionoriginals/sdk) — source, issues, and protocol specification

## Key features

- **Three DID methods** — `did:peer`, `did:webvh`, and `did:btco` behind one resolver (`sdk.did`)
- **Verifiable credentials** — W3C Data Integrity proofs (EdDSA and BBS+ cryptosuites), Multikey encoding
- **Bitcoin Ordinals** — commit/reveal inscriptions with ordinal-aware UTXO selection (`sdk.bitcoin`)
- **External signers** — integrate Turnkey, AWS KMS, or HSMs via the `ExternalSigner` interface
- **Pluggable storage and providers** — bring your own storage adapter, ordinals backend, and fee oracle

## License

[MIT](./LICENSE) © Aviary Tech
