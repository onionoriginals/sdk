---
"@originals/sdk": minor
---

**Hosted WebVH publication now distinguishes an adapter-asserted read-back from an independently confirmed one** (#601).

`publishToWeb`/`publishPreparedToWeb` read the newly written DID log back through the same `storageAdapter` that wrote it, so a private or in-memory adapter satisfied the publication contract exactly as well as a genuinely public HTTPS host — nothing distinguished the two, and a fresh `resolveAssetFromWeb` call reused that same adapter rather than an independent fetch.

- `PublishedWebAsset` gains `hostingEvidence: 'adapter-asserted' | 'independently-verified'`, defaulting to `'adapter-asserted'` — today's actual behavior, now labeled honestly instead of implying public reachability.
- New SDK options `publicReachability` (a check that fetches the advertised URL through a path other than the configured storage adapter) and `requirePublicReachability` (fail the publish, with the prepared publication preserved for retry, when that independent check cannot confirm the exact log that was just written).
- New export `fetchPublicReachabilityCheck`, a ready-made `publicReachability` implementation using a real HTTPS GET.

Both options default to off, so existing callers and every private/in-memory adapter used in tests keep working unchanged. Separating the publication-host capability from the general `storageAdapter` contract, and wiring a production deployment to require the independent check by default, remain open follow-on work.
