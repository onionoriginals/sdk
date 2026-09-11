---
"@originals/sdk": major
---

**Verifier proof-purpose authorization no longer confuses verification methods that merely share a URL fragment** (#593, audit finding H05).

`Verifier.checkProofPurpose` (used by `verifyCredential` and `verifyPresentation`, and by `CredentialManager`'s Data Integrity path) checked whether a proof's `verificationMethod` was listed under the DID document's `assertionMethod`/`authentication` relationship by comparing URL **fragments only**. A relationship entry naming a completely different, foreign DID — e.g. `did:example:other#key-1` — could authorize an unrelated proof key `did:example:issuer#key-1` purely because the fragments matched.

- Relationship entries are now resolved to a complete DID URL the same way DID Core resolves relative references (`#key-1` → `${didDocument.id}#key-1`; an already-absolute entry is used as-is), then compared as full DID URLs. A foreign absolute entry sharing only a fragment no longer authorizes an unrelated key.
- When the verification method's DID uses a method this SDK expects to publish a real relationship document (`did:webvh`, `did:btco`, `did:cel`) but that document fails to resolve, authorization now fails closed instead of silently reporting `verified: true`. The self-certifying `did:key` method, which publishes no separate relationship document by design, is unaffected — it continues to rely on the controller binding and signature check that already run.

Credentials/presentations relying on the old fragment-only match to pass — including any relying on an unresolvable `did:webvh`/`did:btco`/`did:cel` relationship document silently succeeding — may now fail verification, as intended.
