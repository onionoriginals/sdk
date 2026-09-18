---
"@originals/cel": patch
---

**`resolveSat`'s independent-enumeration cross-check now requires the second index's reported ids to fully cover the primary snapshot's known publications before it can upgrade `enumerationAssurance` to `'cross-checked'`** (#907).

A second source configured via `independentEnumeration` could be honestly, self-consistently behind the primary's tip and truthfully report an empty or partial enumeration for a sat the primary already resolved further ahead. Since a strictly smaller list never contains anything "absent from the primary snapshot," this previously earned full `enumerationAssurance: 'cross-checked'` for corroborating nothing. `resolveSat` now also requires every id the primary knows about to appear in the independent source's report — not just the reverse — before crediting the cross-check. A partial or empty report no longer fails resolution (an honestly lagging index is not adversarial); it just leaves `enumerationAssurance` at `'provider-asserted'` for that round, same as when `independentEnumeration` is not configured at all.
