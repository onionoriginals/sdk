---
"@originals/sdk": major
---

**The CEL cryptosuite is renamed, and the proof configuration is now signed** (plan 042).

CEL proofs were labelled `eddsa-jcs-2022`, but the construction was not that suite. There was no hashing step, and the proof configuration was deliberately excluded from the signature. Two consequences, both now fixed:

**The name promised interop it could not deliver.** A conforming Data Integrity implementation could never verify an Originals CEL proof, nor could we verify theirs, while the label said otherwise. New proofs carry `originals-cel-ed25519-jcs-v1` — a bespoke name that claims exactly what it does.

**The proof configuration was unattested.** Because the signature covered only the event, `created`, `verificationMethod`, `proofPurpose` and even `cryptosuite` were editable after the fact without invalidating anything — a freely forgeable timestamp inside a structure whose entire purpose is tamper-evidence. The signing input is now `sha256(JCS(proofConfig)) || sha256(JCS(event))`, mirroring the Data Integrity hashing step.

Binding the configuration is also what makes the migration safe. The verifier dispatches on the suite label, and the two constructions cannot be swapped: relabelling a pre-042 proof to the new suite fails (its signature never covered the configuration), and downgrading a new proof to the old label fails too (the old preimage is not what was signed). Both directions fail closed, so an attacker cannot pick whichever ruleset suits them.

**Logs sealed before this change keep verifying.** They cannot be re-signed, so `eddsa-jcs-2022` remains accepted on READ — permanently, and never written again. Such logs necessarily keep their original weakness: editing `created` on a pre-042 proof is still undetectable, which is precisely why the construction changed. Externally produced artifacts (a competing anchoring's did:btco document, written by another implementation) may also still carry the old label.

`celProofSigningInput`, `canonicalizeEvent`, `CEL_CRYPTOSUITE`, `CEL_CRYPTOSUITE_LEGACY`, `verifyDidKeyProof` and `structuralCheckReason` are now root exports, so an external signer or verifier can produce and check the exact bytes without reverse-engineering them.

**Breaking:**

- New CEL proofs carry `cryptosuite: 'originals-cel-ed25519-jcs-v1'`. Anything matching on the literal `'eddsa-jcs-2022'` must accept both.
- `signingInput.celEvent(entry)` now takes the proof configuration as a second argument: `signingInput.celEvent(entry, proofConfig)`. A signer that ignores it produces a proof that fails at seal time rather than silently later.
- Third-party CEL signers must build the proof configuration first and sign over it. Seal-time self-verification (plan 034) catches implementations that have not migrated, at the call site.
