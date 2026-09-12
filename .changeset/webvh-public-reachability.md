---
"@originals/sdk": minor
---

Hosted WebVH publication now reports an explicit `hostingEvidence:
'adapter-asserted' | 'independently-verified'` on `PublishedWebAsset`.
`'adapter-asserted'` means only the storage adapter's own read-back
confirmed the write — a private or in-memory adapter satisfies that without
the DID log ever being reachable on the public web. Configure a
`publicReachability` check (a ready-made real-HTTPS-GET implementation is
exported as `fetchPublicReachabilityCheck`) to get `'independently-verified'`
evidence, and `requirePublicReachability: true` to fail closed — preserving
the prepared publication for retry — unless the advertised `did.jsonl` is
independently fetchable with exactly the bytes just written.
