---
"@originals/sdk": patch
---

**`AssetResolver`'s independent-enumeration cross-check now requires the second index to observe the same chain tip as the primary before it can upgrade `enumerationAssurance` to `'cross-checked'`** (#907).

A second `SatProvider` configured via `independentEnumeration` could be honestly, self-consistently behind the primary's tip: it truthfully reports an empty or partial enumeration for a sat the primary already resolved further ahead, which previously earned full `enumerationAssurance: 'cross-checked'` for corroborating nothing. `independentEnumeration.inscriptionIds`/`.ownership` are now only built when the independent snapshot's `tipBefore` matches the primary's, mirroring the tip gate the ownership half of this same check already had. A mismatched tip no longer fails resolution; it just leaves `enumerationAssurance`/`ownershipAssurance` at `'provider-asserted'` for that round.
