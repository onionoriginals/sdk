---
"@originals/cel": major
"@originals/sdk": major
---

**Bitcoin resolution now reports whether chain evidence is provider-asserted, independently node-validated, or unavailable** (#594).

`resolveSat`'s `SatResolution` (accepted or not) carries a new required `chainEvidence: 'unavailable' | 'provider-asserted' | 'node-validated'` field, copied from the optional `SatSnapshot.chainEvidence` a provider supplies (omitted on a real snapshot defaults to `'provider-asserted'`; `'unavailable'` means no snapshot was ever obtained, such as when no provider is configured at all). `AssetResolver.resolve`/`resolveDID` and `did.resolveDIDWithMetadata` surface the same qualifier on `didDocumentMetadata.chainEvidence`.

No shipped provider (`RegtestProvider`, `QuickNodeProvider`) performs independent chain validation today, so every current snapshot-backed resolution reports `'provider-asserted'`: chain tip, block, and reveal-position facts are trusted assertions from the same service that supplies Ordinals interpretation, not confirmed by a separately validating Bitcoin node. `resolveSat` never upgrades this qualifier itself — it only reflects what the snapshot claims — so an accepted resolution or `verification.verified: true` must not be read as independent proof of Bitcoin consensus.

**Breaking:** `SatResolution` and `AssetDIDResolution.didDocumentMetadata` (both exported types) gain a new required field. `SatSnapshot.chainEvidence` itself stays optional, so existing providers and snapshot fixtures build and behave unchanged — but any code that builds its own literal `SatResolution` or `didDocumentMetadata` object against these exported types (for example, test mocks of the resolver) needs to add `chainEvidence`.
