---
"@originals/sdk": major
---

Remove `did:peer` entirely as a creation path and genesis layer (did:cel epic, Phase 4 · 5/5). `did:cel` is now the sole genesis layer.

- **Removed:** `DIDManager.createDIDPeer` (all overloads) and the private `getLayerFromDID` helper. There is no supported API to create a `did:peer` identifier.
- **Breaking (`LayerType`):** `'did:peer'` is removed from `LayerType` (`'did:cel' | 'did:webvh' | 'did:btco'`). `OriginalsAsset.determineCurrentLayer` now throws on a `did:peer:` id (a genesis asset is always `did:cel`), and `validTransitions` no longer keys `'did:peer'`.
- **Migration:** `DIDManager.migrateToDIDWebVH` derives the did:webvh slug from the last source-DID segment generically; the numalgo-4 `did:peer` long-form slug branch is gone. `did:cel → did:webvh → did:btco` is unaffected.
- **Kept (legacy read path, unchanged behavior):** `verifyEventLog` still accepts long-form `did:peer:4` self-certification, the CEL-layer resolution branches still read legacy `did:peer` logs, and `documentLoader` still treats `did:peer` as self-certifying so **existing** did:peer credentials keep verifying. Only creation and the genesis layer are removed — verification of legacy artifacts stays.
