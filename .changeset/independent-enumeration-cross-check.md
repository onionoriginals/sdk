---
"@originals/cel": minor
"@originals/sdk": minor
---

Bitcoin sat resolution can now corroborate that the primary provider did not omit an inscription. `resolveSat(snapshot, { independentEnumeration? })` accepts an optional `{ source, inscriptionIds }`: every inscription id a second, independently configured Ordinals index currently reports for the queried sat. If that source lists an id absent from the primary snapshot, resolution fails closed with `inconsistent-evidence` instead of accepting a possibly-incomplete history. The accepted `SatResolution` gains `enumerationAssurance: 'provider-asserted' | 'cross-checked'`, `'cross-checked'` only when such a source was actually consulted and did not disagree.

At the SDK layer, `OriginalsSDK.create({ independentEnumeration: { label, provider } })` configures a second `SatProvider` for this cross-check. When configured, an unreachable independent source also fails resolution closed rather than silently degrading to `'provider-asserted'`. `did.resolveDIDWithMetadata()` exposes the same `enumerationAssurance` on `didDocumentMetadata`.

This corroborates Ordinals enumeration completeness only, a separate dimension from Bitcoin chain/index consistency; it does not by itself establish independently validated Bitcoin consensus. Progresses #594.
