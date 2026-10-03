---
"@originals/auth": patch
---

Reject non-Ed25519 or missing update account curves in createDIDWithTurnkey with an actionable StructuredError before constructing the signer or creating a DID.
