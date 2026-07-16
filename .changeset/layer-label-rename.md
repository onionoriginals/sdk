---
"@originals/sdk": patch
---

Correct the misleading lifecycle layer label: a did:cel genesis asset now reports `currentLayer: 'did:cel'` instead of `'did:peer'`. `LayerType` gains `'did:cel'` (`'did:peer' | 'did:cel' | 'did:webvh' | 'did:btco'`), and `OriginalsAsset.determineCurrentLayer` maps a `did:cel:` id to `'did:cel'`. The migrate transition table, the publish/inscribe genesis-layer gates, `replayProvenance`, and envelope restore all accept `'did:cel'` as the genesis layer (same migration targets as legacy `'did:peer'`).

Legacy `did:peer` assets are unchanged — they still report `'did:peer'` and migrate identically. The `ResourceMigrated` publication credential's `fromLayer` is unchanged (spec non-goal: credentials are untouched). did:cel derivation, verification, ownership, and credentials are all unaffected.
