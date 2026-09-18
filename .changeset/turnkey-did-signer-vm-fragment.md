---
"@originals/auth": patch
---

**`TurnkeyDIDSigner.getVerificationMethodId()` now returns the canonical `did:key:{multibase}#{multibase}` form instead of a bare `did:key:{multibase}` with no fragment** (#872).

`CredentialManager.signCredentialWithExternalSigner` and `MultiSigManager` stamp `signer.getVerificationMethodId()` verbatim onto `proof.verificationMethod`, and `documentLoader.resolveDID`'s offline did:key fast path only resolves a `did:key:` DID when a `#fragment` is present. Without it, a credential or MultiSig contribution signed through the exported `TurnkeyDIDSigner` as an `ExternalSigner` signed successfully but could never be verified. `getVerificationMethodId()` now reuses the same `canonicalDidKeyVm()` helper every other did:key verification-method ID in the codebase already uses.
