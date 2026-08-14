---
"@originals/sdk": major
---

**Four silent signing failures are now loud.** Each one produced a plausible signed artifact that the SDK's own verifier rejected, with no error at sign time — so the failure surfaced arbitrarily far from its cause, often after an asset was already inscribed.

**CEL proofs are verified before they are sealed.** `createEventLog` / `appendEvent` checked only that the signer returned something proof-shaped. A signer using the wrong preimage sealed a genesis whose `did:cel` derived fine, whose log looked well-formed, and which could never verify. Both now verify the proof against its own `did:key` verification method before sealing it — offline, one Ed25519 verify per append. Set `{ verifyOnSign: false }` only to deliberately construct an invalid log, e.g. a tamper-detection fixture.

**The CEL cryptosuite whitelist matches what the verifier can check.** The structural validator admitted `eddsa-rdfc-2022` while the dispatcher failed it closed — a suite the validator accepted but that could never verify. Verification failures now also carry a reason (`unsupported cryptosuite`, `signature mismatch`, `no resolver for <vm>`) instead of a bare "Verification failed".

**`signCredentialWithExternalSigner` signs the bytes the SDK computed.** It hardcoded `cryptosuite: 'eddsa-rdfc-2022'` and then called `signer.sign({document, proof})`, letting the signer choose its own canonicalization. Every didwebvh-shaped signer chooses JCS, so the proof was labelled RDFC and signed over JCS bytes: **no credential signed this way could ever verify.** The SDK now canonicalizes and hashes (RDFC-2022) and the signer signs exactly those bytes via `ExternalSigner.signBytes`. It also binds the signing key to the credential's stated issuer, matching the local-key path.

**`CredentialManager` requires a `DIDManager`.** Without one, Data Integrity proofs fell through to a legacy digest path that no DI proof can satisfy, so `verifyCredential` returned a `false` indistinguishable from a bad signature.

**Breaking:**

- `ExternalSigner` implementations used with `signCredentialWithExternalSigner` must implement `signBytes(data)`. A `sign()`-only signer now throws `EXTERNAL_SIGNER_SIGNBYTES_REQUIRED` rather than emitting an unverifiable credential — such credentials never verified, so no working code depended on this.
- `new CredentialManager(config)` now throws `DID_MANAGER_REQUIRED`; pass a `DIDManager`, or use `sdk.credentials`.
- Signers producing proofs over the wrong preimage now throw at append time instead of writing an unverifiable event.
- Credentials whose `issuer` is not controlled by the signing key now throw `ISSUER_BINDING_MISMATCH` at sign time.

The published `packages/sdk/README.md` also documented `did:peer` as the creation layer (it is `did:cel`) and advertised Turnkey/KMS/HSM support the authorship path does not have. It now carries a **Custody** section making `keyStore` step zero and naming both degrade signals, `key:unpersisted` and `cel:append-skipped`.
