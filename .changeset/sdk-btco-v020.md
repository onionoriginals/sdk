---
'@originals/sdk': major
---

did:btco resolution follows the did:btco method v0.2.0 (plan 011 PR 9c; owner decision Q15). A did:btco's DID document is its inscription's CBOR metadata, versions follow chain order and deactivation is a `deactivated: true` document; the earlier content-based convention (document as inscription content, a 🔥 marker) is no longer read. `DIDManager` resolves did:btco only through an `ordinalsProvider` with `getSatSnapshot` (RegtestProvider, QuickNodeProvider, OrdMockProvider); a `bitcoinRpcUrl` alone now refuses with `ORD_PROVIDER_REQUIRED`. New `btcoDidInscription` and `btcoDidDeactivationInscription` build v0.2.0 inscriptions. `mode: 'current'` reads a did:btco again, a read whose chain tip moved is unresolvable, and a read of another network fails with `BTCO_NETWORK_MISMATCH`. The internal content-fetch adapters are removed.
