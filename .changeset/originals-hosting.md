---
'@originals/sdk': minor
'@originals/vh': minor
---

Hosted publication (plan 011, PR 7b). Asset states may list one did:webvh alias, confirmed only in both directions (P3.6); `verifyOriginal` reports `aliases`, and `verifyOriginalByAlias` resolves through one. New `@originals/vh/fetch` retrieves files SSRF-safely (HTTPS only, no redirects, public addresses only, size and time caps). The SDK adds `publish`, `hostedFiles`, the public reader `loadPublished` (exact-snapshot verification, P9.1) and `servingHeaders` (P9.7).
