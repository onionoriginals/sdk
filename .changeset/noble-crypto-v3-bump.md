---
"@originals/auth": patch
---

Bump the noble-crypto dependency group (`@noble/curves` 1.6→2.2, `@noble/ed25519` 2→3.1, `@noble/secp256k1` 2→3.1, `@scure/base` 1.1→2.2, `@scure/btc-signer` 1.8→2.2) and fix the internal breakage from their v2/v3 export and API changes. For `@originals/auth`, the Turnkey signer is updated for `@noble/ed25519`/`@noble/secp256k1` v3's rename of `utils.randomPrivateKey()` to `utils.randomSecretKey()` and the move of synchronous hash configuration from the (now frozen) `utils`/`etc` objects to the new writable `hashes` object (`hashes.sha256`, `hashes.hmacSha256`, `hashes.sha512`). No public API changes. (The SDK-side adaptations are recorded in `packages/sdk/CHANGELOG.md` under 2.0.0.)
