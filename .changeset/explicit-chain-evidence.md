---
"@originals/cel": minor
"@originals/sdk": minor
---

**Bitcoin resolution now reports whether chain evidence is provider-asserted or independently node-validated** (#594).

`resolveSat`'s `SatResolution` (accepted or not) carries a new `chainEvidence: 'provider-asserted' | 'node-validated'` field, copied from the optional `SatSnapshot.chainEvidence` a provider supplies (omitted defaults to `'provider-asserted'`). `AssetResolver.resolve`/`resolveDID` and `did.resolveDIDWithMetadata` surface the same qualifier on `didDocumentMetadata.chainEvidence`.

No shipped provider (`RegtestProvider`, `QuickNodeProvider`) performs independent chain validation today, so every current resolution reports `'provider-asserted'`: chain tip, block, and reveal-position facts are trusted assertions from the same service that supplies Ordinals interpretation, not confirmed by a separately validating Bitcoin node. `resolveSat` never upgrades this qualifier itself — it only reflects what the snapshot claims — so an accepted resolution or `verification.verified: true` must not be read as independent proof of Bitcoin consensus.

This is additive: `SatSnapshot.chainEvidence` is optional, so existing providers and fixtures are unaffected.
