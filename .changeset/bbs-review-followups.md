---
"@originals/sdk": patch
---

BBS+ (`bbs-2023`) review follow-ups: `createProof` defaults `mandatoryPointers` to `['/issuer']` so derived proofs stay issuer-bound; `DataIntegrityProofManager.createProof` dispatches `bbs-2023` (symmetric with `verifyProof`); `checkProofExpectations` matches `expectedDomain` against string or array `domain`; add and enforce `expectedPresentationHeader` for derived-proof anti-replay; `jsonPointerToPaths` no longer coerces numeric-looking object keys; `skolemizeExpandedJsonLd` no longer throws on a `null` element; and `verifyProof` shares one binding/expectation/key-resolution pass with `verifyDerivedProof` (no duplicated checks or double DID-key resolution).
