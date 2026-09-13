---
"@originals/cel": patch
"@originals/sdk": patch
---

**Explicitly label the sat-trajectory trust boundary in Bitcoin resolution.** `resolveSat`'s accepted `SatResolution` (and `did.resolveDIDWithMetadata()`'s `didDocumentMetadata`) now carries `trajectoryAssurance: 'not-independently-derived'`, always. `ownership` was already documented as a single point-in-time observation, but nothing in the public shape said so where a consumer could read it programmatically. This resolver never walks the UTXO/transfer graph, so it cannot derive *how* a sat arrived at its current holder/satpoint — that stays true even when a caller configures independent enumeration/ownership cross-checking against a second index source, since agreement between two indexes corroborates one snapshot rather than independently deriving the historical transfer path. Progresses #594; narrows the acceptance/trust model for the sat-trajectory dimension rather than building full independent derivation.
