---
'@originals/vh': patch
'@originals/sdk': patch
---

The Bitcoin values are decided (owner decisions of 21 October 2026; spec PR #50 (open); P9.5, P9.10, P9.17, P14.12): an inscription counts at one confirmation on every network, mainnet included, with its depth reported; the media type `application/vnd.originals.vh+jsonl`, the 350,000-byte inscription body limit and the did:btco network prefixes `sig:`, `test:` and `reg:` are no longer provisional. The did:btco method does not yet define the prefixes; they are proposed upstream as decentralized-identity/labs-ordinals-plus#4. No behaviour changes.
