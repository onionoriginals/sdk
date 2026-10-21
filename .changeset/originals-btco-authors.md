---
'@originals/sdk': minor
'@originals/vh': minor
---

did:btco author DIDs (plan 011 PR 9b; P5.13, did:btco method v0.2.0; spec a432). `AuthorDidEvidence` may carry Bitcoin reads of the DID's sat (one per index) instead of a log; versions are inscriptions the index places on the DID's sat number and network whose strict CBOR metadata is the DID document, in chain order, with terminal deactivation; a disputed placement stops the history with `AUTHOR_PLACEMENT_DISPUTED`. For an anchored Original, the did:btco version an entry names must precede the inscription carrying it (or the anchoring inscription, for an entry before the anchor), else `author-version-not-yet-in-effect`; the state is the latest version before the inscription, and the key must hold at both. An Original cannot anchor to its author's own sat, and entries may not name an older author version. Adds `encodeCbor`/`decodeCbor`, `ChainPosition`, `checkBeforeAnchor`; `SatInscription`, `SatEvidence`, `chainOrder` and `readSat` move to the did:btco module (still exported). Packages list a did:btco author as missing identity evidence.
