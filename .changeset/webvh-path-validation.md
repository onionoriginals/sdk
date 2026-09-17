---
"@originals/sdk": patch
---

**`HostedAssets.prepare()` now validates `WebPublicationOptions.paths` at the public seam instead of letting a malformed value reach `WebVHManager`** (#826).

Previously a non-string `paths` element (e.g. `[123]`) escaped as a raw `TypeError`, a well-typed-but-invalid segment (e.g. `[".."]`) escaped as a plain `Error` instead of a `CelError`, and a non-array `paths` value (e.g. a plain string) was silently iterated character-by-character, producing a corrupted `did:webvh` path with no error at all. `prepare()` now rejects any of these with a `CelError` (`ASSET_WEBVH_PATH`) before any signing/storage work begins, using the same segment-validation logic `WebVHManager.createDIDWebVH` already enforces — now shared via the newly exported `isValidWebVHPathSegment`.
