# @originals/sdk

TypeScript SDK for the **Originals Protocol** — create, discover, and transfer digital assets with cryptographically verifiable provenance.

An Original asset **IS a Cryptographic Event Log (CEL)**: every authorship operation appends a signed, hash-chained event, and that log — not any cache — is the source of provenance truth. The lifecycle moves through three layers, and assets migrate unidirectionally through them:

| Layer | Purpose | Cost |
|-------|---------|------|
| `did:cel` | Private creation genesis (offline) | Free |
| `did:webvh` | Public discovery via HTTPS hosting | Hosting only |
| `did:btco` | Transferable ownership on Bitcoin (Ordinals) | Bitcoin fees |

Ownership at the `did:btco` layer IS live Bitcoin sat control — never a credential, and never transferred by editing a DID document.

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
  keyStore: myKeyStore,        // custody: keyStore OR signer — see "Custody" below
});

// 1. Create an asset privately (did:cel genesis — offline, free)
const asset = await sdk.lifecycle.createAsset([
  {
    id: 'artwork-1',
    type: 'image',
    contentType: 'image/png',
    hash: '<sha256-hex-of-content>',
  },
]);

// 2. Publish it for discovery (did:webvh)
//    The second argument identifies the publisher: a did:webvh DID string
//    (or an ExternalSigner bound to one). A bare domain like 'example.com'
//    is also accepted and expands to did:webvh:example.com:user.
const published = await sdk.lifecycle.publishToWeb(
  asset,
  'did:webvh:example.com:user',
);

// 3. Inscribe it on Bitcoin for transferable ownership (did:btco)
//    Requires an ordinalsProvider in the SDK config.
const inscribed = await sdk.lifecycle.inscribeOnBitcoin(published);
```

Bitcoin operations (inscribe, transfer) require an `ordinalsProvider` in the config — use `OrdMockProvider` for development and testing, `OrdinalsClient` for production.

## Custody: configure it before you mint

`createAsset` generates the asset's Ed25519 controller key and, **without a `keyStore`, has nowhere to put it.** The key is dropped, a `key:unpersisted` event is emitted, and the asset can never author another event: `publishToWeb` and `inscribeOnBitcoin` still succeed, but their CEL events are skipped with a `cel:append-skipped` event, so the asset's provenance log silently loses the migration.

Configure custody — a `keyStore`, or a `signer` for remote custody (below) — before minting anything you intend to keep, and subscribe to both signals:

```typescript
sdk.lifecycle.on('key:unpersisted', (e) => { throw new Error(`No custody for ${e.verificationMethod}`); });
sdk.lifecycle.on('cel:append-skipped', (e) => { throw new Error(`Provenance event dropped: ${e.reason}`); });
```

A `keyStore` is `{ getPrivateKey(vmId), setPrivateKey(vmId, key) }` — it must be able to **return** the private key.

### Remote custody (Turnkey, KMS, HSM, passkeys)

Custody that never exports a key implements `OriginalsSigner` — three members, no key export:

```typescript
import { OriginalsSigner, assertSignerConformance } from '@originals/sdk';

const signer: OriginalsSigner = {
  verificationMethodId: 'did:key:z6Mk…#z6Mk…', // absolute VM id
  publicKeyMultibase: 'z6Mk…',                  // lets the SDK pick the suite + self-verify
  signBytes: (bytes) => myCustody.sign(bytes),  // sign EXACTLY these bytes
};
await assertSignerConformance(signer);          // run this in your test suite

const sdk = OriginalsSDK.create({ network: 'mainnet', defaultKeyType: 'Ed25519', signer });
const asset = await sdk.lifecycle.createAsset(resources);        // genesis signed remotely
await sdk.lifecycle.publishToWeb(asset, 'example.com');          // migrate event signed remotely
```

The SDK canonicalizes and hashes (`signingInput.celEvent/witness/didWebvh/credential`); the signer only ever signs opaque bytes. A `signer` is accepted on the config (default authorship signer) and per call on `createAsset`, `publishToWeb`, `inscribeOnBitcoin`, `rotateBtcoKeys`, `authorizeSigner`, and `addResourceVersion`. Adapters bridge the legacy shapes: `signerFromKeyPair`, `signerFromKeyStore`, `signerFromExternalSigner`, `toCelSigner`, `toExternalSigner`. CEL authorship is Ed25519-only.

## Documentation

- [LLM Agent Guide](https://github.com/onionoriginals/sdk/blob/main/docs/LLM_AGENT_GUIDE.md) — full API reference with signatures, types, and examples
- [Quick Reference](https://github.com/onionoriginals/sdk/blob/main/docs/LLM_QUICK_REFERENCE.md) — compact quick-reference card
- [Repository](https://github.com/onionoriginals/sdk) — source, issues, and protocol specification

## Key features

- **Three DID methods** — `did:cel`, `did:webvh`, and `did:btco` behind one resolver (`sdk.did`), plus a legacy read path for pre-existing `did:peer:4` logs
- **Signed provenance** — every authorship operation appends a hash-chained CEL event, verified end-to-end by `asset.verify()`
- **Verifiable credentials** — W3C Data Integrity proofs (EdDSA and BBS+ cryptosuites), Multikey encoding
- **Bitcoin Ordinals** — commit/reveal inscriptions with ordinal-aware UTXO selection (`sdk.bitcoin`)
- **Remote custody** — Turnkey, AWS KMS, HSMs and passkeys author assets, sign credentials, and authorize `did:webvh` logs through the sign-bytes-only `OriginalsSigner` interface (see [Custody](#custody-configure-it-before-you-mint)); `assertSignerConformance` validates any implementation
- **Pluggable storage and providers** — bring your own storage adapter, ordinals backend, and fee oracle

## License

[MIT](./LICENSE) © Aviary Tech
