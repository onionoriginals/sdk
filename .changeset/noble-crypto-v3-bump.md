---
"@originals/sdk": patch
"@originals/auth": patch
---

Bump the noble-crypto dependency group (`@noble/curves` 1.6→2.2, `@noble/ed25519` 2→3.1, `@noble/secp256k1` 2→3.1, `@scure/base` 1.1→2.2, `@scure/btc-signer` 1.8→2.2) and fix the internal breakage from their v2/v3 export and API changes:

- `@noble/curves` subpath exports now require an explicit `.js` extension and were reorganized (`@noble/curves/secp256k1` → `@noble/curves/secp256k1.js`, `@noble/curves/p256` → `@noble/curves/nist.js`, `@noble/curves/bls12-381` → `@noble/curves/bls12-381.js`); the BLS12-381 signer/BBS+ key derivation now uses the `shortSignatures` namespace (`sign`/`verify`/`getPublicKey`/`hash`) and `Point.toBytes()` instead of the removed top-level `sign`/`verify`/`getPublicKey`/`toRawBytes` helpers.
- `@noble/ed25519` and `@noble/secp256k1` v3 renamed `utils.randomPrivateKey()` to `utils.randomSecretKey()` and moved synchronous hash configuration from the (now frozen) `utils`/`etc` objects to a new writable `hashes` object (`hashes.sha256`, `hashes.hmacSha256`, `hashes.sha512`); `noble-init.ts` and the Turnkey signer in `@originals/auth` are updated accordingly.
- `@scure/btc-signer`'s `Address(...).decode()` return type now includes `undefined`; `scriptPubKeyForAddress` guards against it explicitly.

No public API changes.
