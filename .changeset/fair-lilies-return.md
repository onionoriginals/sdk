---
"@originals/sdk": patch
---

Internal refactor (no behavior change): extract `buildResourceManifestService` so the `#resources` `OriginalsResourceManifest` service is constructed in one place instead of being duplicated verbatim in the btco migrate (`inscribeOnBitcoin`) and rotate/authorize (`buildRotatedBtcoDoc`) paths, preventing the two from drifting. The helper's return shape is pinned by an explicit type.
