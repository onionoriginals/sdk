---
"@originals/sdk": minor
---

Ownership is the satoshi, not a CEL event. `transferOwnership` is now a pure Bitcoin sat move that writes nothing to the Cryptographic Event Log — a buyer never inscribes to receive, own, or resell an asset. The CEL is the authorship/provenance record only.

- **Breaking:** `claimOwnership` is renamed `authorizeSigner` and reframed as *optional* author-enablement (establishing a signing key to author new provenance); you own an asset by holding its anchoring satoshi, not by calling this.
- **Breaking:** `ProvenanceChain.transfers`, the transfer query API (`getTransfersFrom`/`getTransfersTo`/`ProvenanceQuery.transfers()`/`TransferQuery`), and the `transferCount` summary field are removed — ownership history lives on the sat's UTXO chain, not the CEL.
- **New:** `LifecycleManager.getCurrentOwner(asset)` reads the current owner live from the anchoring satoshi (`{ address, outpoint } | null`; throws `ORD_PROVIDER_REQUIRED` only when no ordinals provider is configured; fails open to `null` for non-`did:btco` assets, malformed bindings, or providers without an owner index).
- The `transfer` CEL event type is now legacy/read-only: verifiers MUST still accept it (existing logs verify unchanged), writers MUST NOT emit it. The transfer CLI command is removed.

This reverses the earlier decision that made `transfer` a first-class CEL event, re-aligning the implementation with "ownership moves only on Bitcoin."
