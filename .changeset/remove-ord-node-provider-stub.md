---
"@originals/sdk": patch
---

Removed `OrdNodeProvider`, the self-hosted-ord-node `ResourceProvider` stub whose every method rejected with `ORD_NODE_NOT_IMPLEMENTED` (#248/#318) rather than performing any real network I/O.

Per [#328](https://github.com/onionoriginals/sdk/issues/328)'s current-state review, this class was never reachable through any of `@originals/sdk`'s published `exports` subpaths (`.`, `./cel`, `./testing`, `./types`, `./v3`, `./asset-envelope`) — it was dead code carried in `dist/` with no supported way for a consumer to import it. The real, exported live-provider surface (`QuickNodeProvider`, the adapters `OrdHttpProvider`, `RegtestProvider`) already covers production Bitcoin/Ordinals reads; this stub added confusion without capability. A genuine local-ord-node adapter can be added later behind the same `ResourceProvider`/ordinals-adapter contracts if a concrete integration need arises.
