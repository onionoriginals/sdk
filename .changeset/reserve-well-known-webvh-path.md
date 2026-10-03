---
"@originals/sdk": patch
---

Reserve the `.well-known` WebVH path segment at every authoring seam. `paths: [".well-known"]` hosts its log at `/.well-known/did.jsonl`, the same location `paths: []` already uses, so two distinct DIDs would share one log file. `WebVHManager.createDIDWebVH` (and `sdk.did.createDIDWebVH`/`migrateToDIDWebVH`) now throw `WEBVH_PATH_RESERVED`, and `publishToWeb`/`HostedAssets.prepare` fail with `ASSET_WEBVH_PATH_RESERVED`, when the first path segment is `.well-known` (case-insensitive). Omit `paths` to publish at the default location.
