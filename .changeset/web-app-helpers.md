---
'@originals/sdk': minor
---

Add browser-safe helpers for web apps to `@originals/sdk/originals`.
Easel, Commission Desk and the landing each wrote their own copies of these.

- `hostedFetch({ origin?, fetch?, cache? })`: a `HostedFetch` over the
  platform's `fetch`. It refuses as `safeFetch` does: `FETCH_SCHEME`,
  `FETCH_REDIRECT` (redirects are never followed), `FETCH_STATUS`,
  `FETCH_TOO_LARGE`, `FETCH_FAILED` and `FETCH_ABORTED`, all
  `unavailable-bytes`. It sends no credentials and skips the HTTP cache.
- `httpSharedHost({ sdk, aliasDid, read, send?, submitBase? })`: a
  `SharedHost` for an `@originals/host` instance. Also `encodeSubmission`
  (the submit route's wire format), `readHostAnswer`, `SubmitRefusedError`
  and `siteKeyOf`.
- `webvhAlias(aliases)` and `aliasSegment(original)`, which returns the
  `o-<scid16>` path segment.
- `uploadOrder(path)` and `publicationUploads(sdk, did, alias)`.
- `blockingReasons(reasons)` and `INFORMATIONAL_REASONS`. `not-anchored` is
  informational for a valid, unanchored Original (P7.10).

`ORIGINALS.md` documents these helpers and the `sync`-on-open pattern for
apps that keep their own copy beside a shared host.
