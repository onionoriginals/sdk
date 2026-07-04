---
"@originals/sdk": patch
---

Harden credential signing and verification, fixing five issues found in the full codebase review:

- **utils**: `validateCredential` now accepts W3C VC 2.0 credentials — the `https://www.w3.org/ns/credentials/v2` context and `validFrom` as an alternative to `issuanceDate` — so the SDK's own issued credentials no longer fail deserialization and asset verification (#264).
- **vc**: status list `encodedList` decompression (`StatusListManager.decodeBitstring`, `BitstringStatusList.decode`) is now capped at 16 MiB, rejecting gzip/DEFLATE bombs from attacker-suppliable status list credentials (#262).
- **vc/crypto**: legacy credential and multi-sig proof signing/verification now select the signature algorithm from the key's multicodec type via the new `signerForKeyType` helper instead of `config.defaultKeyType`, so verification no longer depends on the verifier's local configuration (#261).
- **vc**: the document loader's verification-method registry fallback for resolved DID documents is restricted to self-certifying methods (did:key/did:peer); keys removed from a hosted did:webvh or on-chain did:btco document can no longer be resurrected from the process-global registry (#260).
- **vc**: `CredentialManager.signCredential` populates the verification method's `controller` from the resolved DID document instead of `credential.issuer`, restoring the signing-side issuer-binding guard so a key for one DID can no longer mint credentials claiming a foreign issuer; the refusal fails closed instead of falling through to legacy signing (#259).
