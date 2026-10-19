---
'@originals/sdk': minor
'@originals/vh': minor
---

Author DID rotation, freshness and forks (plan 011, PR 6). `verifyOriginal` accepts other copies of the asset log and the retained versionIds for the Original and its author DIDs, and reports `assetFreshness`, a stale author DID history, an unresolved `fork` and the versionIds to `retain` (P7.6, P7.8, P6.6). The SDK store retains the highest verified versionIds and keeps diverging branches, so older prefixes are stale and forks stay visible and non-current until anchoring (owner decision Q5). Import no longer replaces stored author evidence with an older history. `OriginalsStore` gains `getRetained`, `putRetained`, `putBranch` and `getBranches`.
