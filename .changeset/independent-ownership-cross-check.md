---
"@originals/cel": minor
"@originals/sdk": minor
---

The same second, independently configured Ordinals index used for enumeration cross-checking can now also corroborate sat ownership/trajectory. `resolveSat(snapshot, { independentEnumeration? })`'s `{ source, inscriptionIds, ownership? }` accepts an optional independent `owner`/`satpoint` observation; if supplied, it must match the primary snapshot's `ownership` exactly, or resolution fails closed with `inconsistent-evidence` instead of accepting a possibly-misreported current holder. The accepted `SatResolution` gains `ownershipAssurance: 'provider-asserted' | 'cross-checked'`, `'cross-checked'` only when independent ownership evidence was actually supplied and agreed.

At the SDK layer, `OriginalsSDK.create({ independentEnumeration: { label, provider } })` now automatically also cross-checks ownership using the same second `SatProvider`'s snapshot already fetched for enumeration, at no extra network cost. `did.resolveDIDWithMetadata()` exposes the same `ownershipAssurance` on `didDocumentMetadata` alongside `enumerationAssurance`.

This corroborates who currently holds the sat, a separate dimension from enumeration completeness and Bitcoin chain/index consistency; a provider could enumerate every inscription correctly while still misreporting the current owner. Progresses #594.
