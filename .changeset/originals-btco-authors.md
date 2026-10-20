---
'@originals/sdk': minor
'@originals/vh': minor
---

did:btco author DIDs (plan 011 PR 9b; P5.13, did:btco method v0.2.0). `AuthorDidEvidence` may carry a Bitcoin read of the DID's sat instead of a log; versions are inscriptions whose strict CBOR metadata is the DID document, in chain order, with terminal deactivation. Anchored entries are checked against the versions before them in chain order, an Original cannot anchor to its author's own sat, and entries may not name an older author version. Adds `encodeCbor`/`decodeCbor`, `ChainPosition`; `satEvidence` carries inscription metadata; packages list a did:btco author as missing identity evidence.
