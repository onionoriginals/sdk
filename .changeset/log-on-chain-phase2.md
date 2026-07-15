---
"@originals/sdk": minor
---

Content-as-ordinal, provenance-in-metadata (#407 phase 2). The did:btco
anchoring inscription now BECOMES the asset: its content is the asset's current
media (the most-recent resource's bytes) and its CBOR metadata carries the
byte-light provenance (the did:btco DID document with its `#cel` anchor + the
full CEL log). The verifier reads the `#cel`/witness commitment from inscription
metadata (falling back to content for phase-1 inscriptions) and adds a
content-as-ordinal gate binding the on-chain media to the log's most-recent
resource hash. A new `LifecycleManager.resolveAssetFromSat(satoshi)` reconstructs
and fully verifies an asset — provenance and current media — from a bare
satoshi, with no envelope and no host. Provenance is now recoverable from
Bitcoin alone. Pure-reference assets (no inline media) inscribe the DID document
as content and carry no media on-chain. `OrdinalsProvider.createInscription`
gains a `metadata` parameter (and a `{ content, metadata }` deferred-builder
return), and `getInscriptionById` surfaces inscription metadata.
