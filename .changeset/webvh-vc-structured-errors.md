---
"@originals/sdk": patch
---

**`signCredential`, `signCredentialMultiSig`, and `createDIDWebVH` now throw `StructuredError` on caller-input validation failures instead of a raw `Error`** (#711).

Per CLAUDE.md's public-seam contract ("Use `StructuredError` or the CEL 3 `CelError` contract appropriate to the public seam"), a caller following the SDK's own `catch (e) { if (e.code === 'X') ... }` idiom around these three documented public methods previously got `undefined` for `.code` on a validation failure — indistinguishable from an unrelated error such as a network failure.

- `CredentialManager.generateProofValue` (the legacy fallback path `signCredential` uses when the verification method isn't a resolvable `did:`) now wraps a malformed `privateKeyMultibase` as `StructuredError('INVALID_KEY', ...)`, the same code `LifecycleManager` already uses for this failure mode.
- `MultiSigManager.assertEd25519SignerKey` (used by `signCredentialMultiSig`) now throws `StructuredError('INVALID_KEY', ...)` for a malformed signer key and `StructuredError('MULTISIG_ED25519_REQUIRED', ...)` for a non-Ed25519 signer key.
- `WebVHManager.createDIDWebVH`'s caller-input validation now throws typed errors: `WEBVH_INVALID_PATH_SEGMENT`, `WEBVH_PREROTATION_EXTERNAL_SIGNER_UNSUPPORTED`, `WEBVH_VERIFICATION_METHODS_REQUIRED`, `WEBVH_UPDATE_KEYS_REQUIRED`, and `WEBVH_VERIFIER_REQUIRED` — the last reusing the exact code `identity-operations.ts`'s `resolveVerifier` and `updateDIDWebVH` already use for the identical sign-only-signer-without-verifier condition, so all three DID write paths share one error contract for this failure.

Internal/dependency-invariant failures in these same files (e.g. a broken `didwebvh-ts` module load, or a malformed document returned from it) are unchanged — they aren't a caller-input mistake, so aren't part of this typed-error contract.
