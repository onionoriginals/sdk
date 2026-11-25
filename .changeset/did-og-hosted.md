---
"@originals/vh": minor
"@originals/host": minor
---

did:og hosting: the shared-host save of P6.7 (atomic per Original, durable
before acknowledging, byte-identical retries, stale-parent refusals and the
P7.20 rule for unendorsed parents), the did:webvh alias check in both
directions (P3.6), and the hosted layout and P9.7 headers (P14.11). In
`@originals/host`, `createOgRoutes` and `ogFileStore` serve saves and the
accepted log and resources over HTTP. Reproduces the hosted vector's
exchanges and served files (T14-079, T14-063).
