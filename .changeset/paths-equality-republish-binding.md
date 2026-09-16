---
"@originals/sdk": patch
---

Fix `HostedAssets.prepare()`'s republish binding check comparing a supplied `paths` option against the existing hosted asset's path by presence instead of equality (#761).

Republishing an already-hosted asset with the exact same custom `paths` it was originally published with (e.g. `paths: ["custom", "myasset"]`) was rejected with `ASSET_WEBVH_BINDING`, even though the path hadn't changed — the check only tested whether `options.paths` was truthy, not whether it matched the asset's existing path. `options.paths` is now compared element-wise against the existing path segments; a genuine mismatch still fails closed with `ASSET_WEBVH_BINDING`.
