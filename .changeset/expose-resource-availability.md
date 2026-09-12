---
"@originals/sdk": minor
---

Expose `resourceAvailability` on an accepted `resolveAssetFromSat`/`AssetResolution`
result: a per-historical-resource-version `"bitcoin-inline" | "referenced"` label
naming whether that version's bytes are recoverable from the accepted Bitcoin
inscriptions alone, or depend on a separate off-chain host. At most one current
resource is inlined per Bitcoin publication, so a multi-resource asset commonly has
both labels at once; `"referenced"` is the expected, by-design state for the rest,
not a defect.
