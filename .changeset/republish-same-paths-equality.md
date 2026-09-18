---
"@originals/sdk": patch
---

Fix `HostedAssets.prepare()` (used by `sdk.lifecycle.publishToWeb`/`prepareWebPublication`) rejecting a republish of an already-hosted asset with `ASSET_WEBVH_BINDING` whenever `WebPublicationOptions.paths` was supplied, even when it exactly matched the asset's existing bound path. The republish branch compared `options.paths` by truthiness instead of by equality against the existing binding, so replaying the exact same `WebPublicationOptions` used on the original `publishToWeb` call — a natural retry/idempotent pattern — failed on every call after the first unless `paths` was omitted entirely. `options.paths` is now decoded from the asset's existing hosted path and compared element-by-element; a caller-supplied `paths` that differs from the existing binding is still rejected, matching the domain check immediately to its left.
