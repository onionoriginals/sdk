---
"@originals/sdk": minor
"@originals/cel": minor
---

Label Bitcoin sat resolutions with `chainEvidence: 'provider-asserted' | 'node-validated'` (and an optional non-secret `source`), so a resolved asset, its `verification.publication`, and `did.resolveDIDWithMetadata(...).didDocumentMetadata` are explicit about whether the chain/tip/block facts behind an `accepted` result came from an independently validating Bitcoin node or only from the same RPC/index endpoint that supplied the Ordinals interpretation. Every current production adapter (`QuickNodeProvider`, `RegtestProvider`) reports `'provider-asserted'`. `verified`/`accepted` keeps meaning authenticated CEL history plus a complete, internally consistent provider snapshot — it never implied independently validated Bitcoin consensus, and this change makes that explicit rather than changing the check itself.
