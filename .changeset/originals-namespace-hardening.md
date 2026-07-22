---
"@originals/landing": patch
---

Harden the durable Originals host routes (issues surfaced by review of #431's merged code):

- **Namespace pre-squat blocked.** `hostPut` now rejects a write to a `user-<slug>` path segment that isn't the caller's own, so an authenticated user can no longer claim another user's predictable publisher DID path (`user-<victim>/did.jsonl`) before them and lock them out. Asset paths are hash-derived (not `user-`-prefixed) and remain guarded by the store's first-writer-wins owner sidecar. The `webvh.ts` doc now describes the enforcement accurately.
- **Malformed URL → 400, not 500.** A crafted percent-encoding (`%GG`) made `decodeURIComponent` throw an uncaught `URIError` (500). Both `hostPut` and `hostGet` now decode via a guarded helper and return a clean 400.
- Removed a stray empty changeset (`red-dots-grab.md`).
