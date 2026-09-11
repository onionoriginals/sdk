---
"@originals/sdk": patch
---

Fix a verifier authorization bypass: `Verifier.checkProofPurpose` matched a proof's `verificationMethod` against a DID document's `assertionMethod`/`authentication` relationship array by comparing fragments alone, so a foreign, already-absolute relationship entry (e.g. `did:example:other#key-1`) could authorize an unrelated `verificationMethod` (e.g. `did:example:issuer#key-1`) solely because both share the same fragment. Relationship entries are now normalized to a full DID URL before comparison and matched in full.
