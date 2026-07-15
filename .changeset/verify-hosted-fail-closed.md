---
"@originals/sdk": minor
---

`OriginalsAsset.verify()` now fails closed for hosted (URL-only) resources whose integrity cannot be confirmed. Previously, a resource that carried only a `url` (no inline `content`) silently passed on a structural hex-shape check whenever no `fetch` was injected or the fetch threw. Now a fetch error, a hash mismatch, or the absence of an injected fetcher for a hosted resource all cause verification to return `false` rather than silently pass (fixes #368).

This closes a tamper-evidence hole in the did:webvh layer, whose entire purpose is HTTPS-hosted, hash-addressed content. Inline-content assets (did:peer / did:cel with embedded bytes) are unaffected — they never reach the URL branch. A resource carrying both `content` and `url` still verifies via the authoritative inline path.

Behavior change: callers verifying did:webvh (hosted) assets must now pass a `fetch` implementation to `verify({ fetch })`; without one, hosted resources are treated as unverifiable and verification fails.
