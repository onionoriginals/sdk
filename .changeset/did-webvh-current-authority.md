---
"@originals/sdk": patch
"@originals/cel": patch
---

Fix: a mutable did:webvh document cached (or pinned) by `DIDManager` could remain authoritative for up to 24 hours — or indefinitely if pinned — after being rotated or recovered by a different process/host, since only that same `DIDManager` instance's own mutations invalidated its cache.

`DIDManager.resolveDID(did, { mode: 'current' })` now bypasses the cache entirely for did:webvh and always re-resolves live; `Verifier.checkProofPurpose`, `DocumentLoader`, and the CEL key resolver (`createDidManagerKeyResolver`) now request this mode when deciding whether a signing key is presently authorized, so an externally rotated or recovered key can no longer be accepted from a stale or pinned cache entry. A cached/pinned document remains available as an explicit offline snapshot via the new `DIDManager.resolveDIDWithFreshness(did, { mode })` (`'cache' | 'current' | 'offline'`), which also reports `source`, `fresh`, `resolvedAt`, and `pinned` metadata. Default (no options) `resolveDID` behavior, and all other DID methods, are unchanged.
