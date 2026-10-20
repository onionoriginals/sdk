---
'@originals/sdk': minor
'@originals/vh': minor
---

Anchored Originals, verifier side (plan 011 PR 9a; plan 012). Asset states may list one did:btco alias: the anchoring entry, after which the sat never changes. `verifyOriginal` takes Bitcoin evidence (`SatEvidence`) and assembles the log from the anchoring sat: the anchor, conflicting anchors, accepted and ignored inscriptions, author checks at inscription time (P9.15), and a provisional ownership report. The SDK adds `anchor`, `InscriptionClock`, `satEvidence` and Bitcoin evidence for `get` and `load`; the sat reader records block timestamps.
