# @originals/host

## 0.2.1

### Patch Changes

- Updated dependencies [bfda41c]
  - @originals/sdk@6.0.0

## 0.2.0

### Minor Changes

- d7b1f1a: New package `@originals/host`: the protocol-side server of the landing (did:webvh hosted layout and durable per-user Originals routes, shared-host saves, the `/context` document, the inscriptions store, reconciliation, block-driven completion and server-side anchoring), moved out of `apps/landing/server` without behavior changes. It runs on Bun and does not depend on `@originals/auth` or Turnkey: `createOriginalsRoutes` takes an injected `authenticate(req)` that names the session subject, and `buildFetch`/`servedWebvhHosts` take the extra did:webvh hosts an instance serves. The landing now consumes it, wiring its JWT check and legacy did:webvh domain through those seams.

### Patch Changes

- Updated dependencies [194f7ab]
- Updated dependencies [989665c]
- Updated dependencies [65d3a8a]
- Updated dependencies [0dc1980]
- Updated dependencies [ae19f3c]
- Updated dependencies [fdb4ea4]
- Updated dependencies [1ff1939]
- Updated dependencies [230855f]
  - @originals/vh@0.3.0
  - @originals/sdk@5.1.0
