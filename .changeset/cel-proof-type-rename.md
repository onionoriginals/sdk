---
"@originals/cel": major
"@originals/sdk": major
---

**CEL proofs no longer claim to be W3C Data Integrity.**

Every CEL proof carried `type: "DataIntegrityProof"`, asserting that a conforming Data Integrity implementation could verify it. None can. The cryptosuite is ours and unregistered, so a conforming verifier reads past the type, fails to recognise the suite, and rejects — naming the envelope after the spec only moved that discovery one field later. Plan 042 already fixed this for the `cryptosuite` field; this does the same for `type`, which is the field a reader looks at first.

```
CEL_PROOF_TYPE        = 'OriginalsCelProof'   — written from now on
CEL_PROOF_TYPE_LEGACY = 'DataIntegrityProof'  — accepted on READ, permanently
```

Carried by every proof in a CEL log: the controller's event signatures and the `bitcoin-ordinals-2024` witness attestations alike. Both are Originals constructions; neither is Data Integrity. Genuine W3C credential proofs (`eddsa-rdfc-2022`, `bbs-2023`) are untouched and keep the W3C type — those really are conformant.

This renames a claim. It does not change which bytes are signed, and no cryptography moves.

**Logs sealed before this change keep verifying.** They cannot be re-signed, so `DataIntegrityProof` remains accepted on read, forever. External artifacts written by other implementations — a competing anchoring's did:btco document — may carry it too.

**Accepting both labels opens no door.** The type is not a dispatch key: the cryptosuite selects the preimage, and since 042 the proof configuration — `type` included — is inside the signature. So relabelling a current-suite proof to the legacy type breaks it, and relabelling a legacy proof to the new one breaks it as well. Both directions fail closed, which is what made this shippable rather than a downgrade vector.

`CEL_PROOF_TYPE`, `CEL_PROOF_TYPE_LEGACY`, `CEL_PROOF_TYPES` and `isCelProofType` are root exports of both packages, alongside the existing suite constants.

**Breaking:**

- New CEL proofs carry `type: 'OriginalsCelProof'`. Anything matching on the literal `'DataIntegrityProof'` must accept both — use `isCelProofType`.
- This applies to witness proofs as well as event proofs.

Reading is strictly widened, so nothing already minted breaks.
