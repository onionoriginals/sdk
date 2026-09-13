---
"@originals/sdk": major
"@originals/cel": major
---

Expose `resourceAvailability` on an accepted `resolveAssetFromSat`/`AssetResolution`
result: a per-historical-resource-version `"bitcoin-inline" | "referenced"` label
naming whether that version's bytes are recoverable from the accepted Bitcoin
inscriptions alone, or depend on a separate off-chain host. Each Bitcoin publication selects one resource body to inline; resources with a
matching media type and digest may share those bytes. A multi-resource asset commonly has
both labels at once; `"referenced"` is the expected, by-design state for the rest,
not a defect.

The core sat result also reports current-resource availability. Both layers use the same media-type/digest matching rule and shared record shape; historical versions remain explicit at the SDK level.

The new required fields on exported resolution results can affect callers constructing result literals.
