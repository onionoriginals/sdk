---
"@originals/cel": minor
"@originals/sdk": minor
---

Bitcoin sat resolution can now corroborate that a confirmed inscription's reported media type, content bytes and CEL metadata tag are actually what is encoded on-chain, rather than trusting the same indexer that supplied enumeration/ownership. `resolveSat(snapshot, { independentContent? })` accepts an optional array of `{ inscriptionId, mediaType, contentDigest, metadataDigest }`. If it disagrees with an accepted publication's reported content, media type, or metadata, resolution fails closed with `inconsistent-evidence`. The accepted `SatResolution` gains `contentAssurance: 'provider-asserted' | 'cross-checked'`, `'cross-checked'` only once independent evidence covered every accepted publication and none of it disagreed.

At the SDK layer, `OriginalsSDK.create({ contentValidator })` configures independent content derivation. The exported `createBitcoinCoreContentValidator({ endpoint, rpcAuth? })` fetches each confirmed inscription's reveal transaction from a separately trusted Bitcoin Core node and parses its taproot witness with this SDK's own Ordinals envelope interpreter — never re-fetching from the same Ordinals indexer. A configured validator that is unreachable fails resolution closed with `incomplete` rather than silently falling back to an unqualified provider claim. `did.resolveDIDWithMetadata()` exposes the same `contentAssurance` on `didDocumentMetadata`.

This corroborates content/media binding only, a separate dimension from Bitcoin chain/index consistency, Ordinals enumeration completeness, and ownership. Progresses #594.
