---
"@originals/sdk": minor
"@originals/landing": patch
---

**Hosted WebVH publication now distinguishes an adapter-asserted read-back from an independently confirmed one** (#601).

`publishToWeb`/`publishPreparedToWeb` read the newly written DID log back through the same `storageAdapter` that wrote it, so a private or in-memory adapter satisfied the publication contract exactly as well as a genuinely public HTTPS host — nothing distinguished the two, and a fresh `resolveAssetFromWeb` call reused that same adapter rather than an independent fetch.

- `PublishedWebAsset` gains `hostingEvidence: 'adapter-asserted' | 'independently-verified'`, defaulting to `'adapter-asserted'` — today's actual behavior, now labeled honestly instead of implying public reachability.
- New SDK options `publicReachability` (a check that fetches the advertised URL through a path other than the configured storage adapter) and `requirePublicReachability` (fail the publish, with the prepared publication preserved for retry, when that independent check cannot confirm the exact log that was just written).
- New export `fetchPublicReachabilityCheck`, a ready-made `publicReachability` implementation using a real HTTPS GET.

Both options remain opt-in for SDK callers. The landing app requires independent reachability for anonymous and signed-in publication, including cold recovery before saving an account record or deleting its retry wrapper. The default checker omits credentials and cached responses, refuses redirects, and caps streamed responses at 2 MiB with a ten-second deadline. Missing required checker configuration is rejected before any writes; a failed check after upload preserves the exact prepared publication for retry. Separating the publication-host capability from the general `storageAdapter` contract remains follow-on work.
