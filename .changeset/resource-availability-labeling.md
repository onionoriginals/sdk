---
"@originals/cel": minor
"@originals/sdk": minor
---

`resolveSat`'s accepted result now includes `resourceAvailability`, reporting per
current resource whether the supplied Bitcoin snapshot's accepted publications
actually carried that exact digest inline (`bitcoin-inline`) or not
(`referenced`). One publication carries at most one inline resource body, so a
multi-resource asset was never fully chain-recoverable from inline content
alone; callers relying on `AssetResolver.resolve()`'s
`verification.publication` can now see exactly which resources remain
recoverable without a host, instead of inferring it from `missingResources`.
