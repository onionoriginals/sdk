---
"@originals/sdk": major
"@originals/auth": major
---

**Remote custody can author assets.** Turnkey, KMS, HSM, MPC and passkey backends never export a private key, and the SDK's authorship path required one — `KeyStore.getPrivateKey(vmId)`. Any such backend was locked out of the recommended tier entirely.

**One signer interface.** `OriginalsSigner` is three members — `verificationMethodId`, `publicKeyMultibase`, and `signBytes(bytes)` — the smallest capability a custody backend can offer. The SDK canonicalizes and hashes; the signer only ever signs opaque bytes. It is accepted on `OriginalsConfig` and per call on `createAsset`, `publishToWeb`, `inscribeOnBitcoin`, `rotateBtcoKeys`, `authorizeSigner` and `addResourceVersion`. Adapters convert in both directions: `signerFromKeyPair`, `signerFromKeyStore`, `signerFromExternalSigner`, `toCelSigner`, `toExternalSigner`.

**The provenance leak this closes:** `publishToWeb` accepted an `ExternalSigner`, but that signer only authorized the did:webvh log. The asset's own CEL `migrate` event was appended by a keyStore-only path, so a remote-custody caller doing everything right got a published asset whose provenance log was **missing its migration event** — reported as success. Every authorship append now accepts the configured or per-call signer.

**One signing-input namespace.** `signingInput` exposes the four (and only four) preimages this SDK signs: `celEvent`, `witness`, `didWebvh`, `credential`. Every internal signing path routes through it, so "which bytes do I sign?" has one answer and the four cannot drift apart. Note `didWebvh` delegates to didwebvh-ts's own `prepareDataForSigning` — it is `sha256(JCS(proof)) || sha256(JCS(document))`, not JCS over the pair, and reimplementing it by hand produces proofs that never verify.

**A conformance harness.** `assertSignerConformance(signer)` lets any custody backend prove its implementation before shipping, and `MockRemoteSigner` (signBytes-only, no key export) exercises the full create → publish → inscribe → rotate flow in the SDK's own tests. No test previously exercised a non-exporting backend, which is why this went unnoticed.

**`@originals/auth`:** both Turnkey signers now implement `signBytes` via a single shared `turnkeySignBytes` primitive, so a Turnkey key satisfies `OriginalsSigner` and can author CEL events and sign credentials — not only did:webvh logs. The byte-level code already existed, duplicated across the two signers and kept in sync by comment.

**Breaking:**

- `@originals/auth`'s root entry no longer re-exports `./server`. Importing so much as a type from `@originals/auth` pulled `jsonwebtoken`, `@turnkey/sdk-server` and Express into browser bundles. Import server utilities from `@originals/auth/server` and client utilities from `@originals/auth/client`; the root now exports types plus the isomorphic `turnkeySignBytes`.
- `ExternalSigner`, `CelSigner`, and using a `KeyStore` as a signing authority are deprecated in favour of `OriginalsSigner`. They still work; removal is a later release. `KeyStore` remains supported for key *persistence*.
- The Turnkey signers' "no signature returned" error message is now one shared string naming the expected `activity.result.signRawPayloadResult.{r,s}` shape.

Also adds `base58AddressToEd25519Multikey`: custody backends hand back an address, not a Multikey, and Turnkey's Ed25519 accounts use `ADDRESS_FORMAT_SOLANA` — base58 of the raw key, with no multicodec header. Building `did:key:${address}` from it yields something that is not a valid did:key, a mistake consumers kept re-deriving.
