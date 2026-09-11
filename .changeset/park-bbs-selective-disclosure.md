---
"@originals/sdk": major
---

**BBS+ selective disclosure (`bbs-2023`) is parked and disabled end to end** (#591).

A holder could derive a BBS proof that hid `validUntil` and `credentialStatus`, and the verifier read the missing fields as "no policy" and returned `verified: true` for an expired, status-bearing credential. Closing that needs a mandatory-disclosure profile enforced at issuance, and credentials already issued with permissive pointers cannot be repaired by changing issuance. Rather than ship a verifier that guesses which disclosures a proof was allowed to omit, the suite is removed.

- `DataIntegrityProofManager.createProof` throws `Cryptosuite bbs-2023 is disabled` and `verifyProof` returns `verified: false` with that error for any `bbs-2023` proof, base or derived. `Verifier.verifyCredential` and `CredentialManager.verifyCredential` inherit the rejection, so no previously issued BBS credential verifies.
- **Removed:** `BBSCryptosuiteManager`, `BBSCryptosuiteUtils`, `BBSProofOptions`, `BBSDeriveOptions`, `BBSVerifyOptions`, `SelectiveDisclosureOptions`, `DerivedProofResult`, `CredentialManager.prepareSelectiveDisclosure`, `CredentialManager.deriveSelectiveProof`, the `mandatoryPointers` / `publicKey` fields of `ProofOptions`, and the `expectedChallenge` / `expectedDomain` / `expectedPresentationHeader` / `expectedController` options of `Verifier.verifyCredential`, which only the BBS suite honoured. `Verifier.verifyPresentation` keeps its own `expectedChallenge` / `expectedDomain` checks.
- **Removed dependency:** `@digitalbazaar/bbs-signatures`. `Bls12381G2Signer` and the `Bls12381G2` multikey codec stay; they are generic key utilities.

`eddsa-rdfc-2022` is the only credential cryptosuite. The code is retained in git history for when a disclosure profile exists.
