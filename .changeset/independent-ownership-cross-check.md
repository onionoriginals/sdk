---
"@originals/cel": minor
"@originals/sdk": minor
---

Bitcoin sat resolution can now corroborate current sat *ownership*, not just enumeration. The same independently configured second Ordinals index used by `independentEnumeration` (see the enumeration cross-check) may also report its own current-holder observation via `resolveSat(snapshot, { independentEnumeration: { ownership? } })`: `{ owner, satpoint }`. If supplied and it disagrees with the primary snapshot's `ownership`, resolution fails closed with `inconsistent-evidence` instead of accepting an unqualified ownership claim. The accepted `SatResolution` gains `ownershipAssurance: 'provider-asserted' | 'cross-checked'`, `'cross-checked'` only when independent ownership evidence was actually supplied and agreed.

At the SDK layer, `OriginalsSDK.create({ independentEnumeration: { label, provider } })` now also cross-checks ownership automatically, reusing the same independent snapshot already fetched for enumeration — no extra network round trip, no new SDK option. `did.resolveDIDWithMetadata()` exposes the same `ownershipAssurance` on `didDocumentMetadata` alongside `enumerationAssurance`.

This corroborates current sat ownership only, a separate dimension from Ordinals enumeration completeness and Bitcoin chain/index consistency; it does not by itself establish independently derived sat transfer history. Progresses #594.
