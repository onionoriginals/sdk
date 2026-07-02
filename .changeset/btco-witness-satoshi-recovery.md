---
"@originals/sdk": patch
---

Fix `BitcoinWitness.witness()` breaking btco witnessing with providers that don't return a satoshi from `createInscription` (e.g. the shipped `OrdHttpProvider`). The witness now recovers the satoshi via `getSatoshiFromInscription` before failing closed, so a successful inscription no longer throws "did not return a satoshi ordinal". It still fails closed when the satoshi is genuinely unavailable, since `did:btco` requires a numeric satoshi.
