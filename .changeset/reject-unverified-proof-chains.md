---
"@originals/sdk": major
---

**Data Integrity proof-chain options are no longer silently ignored** (#604).

`ProofOptions.previousProof` and a multi-proof array were accepted by the public Data Integrity API but never actually checked as a chain: `EdDSACryptosuiteManager` dropped `previousProof` when creating a proof, and `Verifier.verifyCredential`/`verifyPresentation` verified only `proof[0]` of an array while implying the whole credential/presentation was checked. A caller could believe a chained or multi-proof approval was verified when only a single, independent signature was.

- `DataIntegrityProofManager.createProof` now throws `ProofOptions.previousProof is not supported` instead of silently dropping it.
- `Verifier.verifyCredential` and `verifyPresentation` now return `verified: false` for a credential/presentation with more than one proof, directing callers to `verifyCredentialMultiSig()` (which has its own threshold policy, not proof chaining) instead of silently checking only the first proof.
- `Verifier.verifyCredential` and `verifyPresentation` now return `verified: false` when the selected proof declares `previousProof`, since no code verifies that dependency.
- `EdDSACryptosuiteManager.createProofConfiguration` now honors a caller-supplied `created` timestamp instead of always overwriting it with the current time.

Callers that never supplied `previousProof` or multi-proof arrays to the ordinary single-proof verification API are unaffected.
