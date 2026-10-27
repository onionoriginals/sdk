---
"@originals/host": minor
"@originals/landing": patch
---

New package `@originals/host`: the protocol-side server of the landing (did:webvh hosted layout and durable per-user Originals routes, shared-host saves, the `/context` document, the inscriptions store, reconciliation, block-driven completion and server-side anchoring), moved out of `apps/landing/server` without behavior changes. It runs on Bun and does not depend on `@originals/auth` or Turnkey: `createOriginalsRoutes` takes an injected `authenticate(req)` that names the session subject, and `buildFetch`/`servedWebvhHosts` take the extra did:webvh hosts an instance serves. The landing now consumes it, wiring its JWT check and legacy did:webvh domain through those seams.
