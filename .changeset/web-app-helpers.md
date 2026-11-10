---
'@originals/sdk': minor
---

Add browser-safe helpers for web apps to `@originals/sdk/originals`.
Easel, Commission Desk and the landing each wrote their own copies of these.

- `hostedFetch({ origin?, hosts?, fetch?, cache? })`: a `HostedFetch` over the
  platform's `fetch`. Without `origin` it reads only from the `hosts` the
  caller vouches for (`FETCH_HOST_NOT_ALLOWED`), since a browser cannot check
  what a name resolves to (P8.5). It refuses as `safeFetch` does: `FETCH_URL`,
  `FETCH_SCHEME`, `FETCH_PRIVATE_ADDRESS` (an IP-literal host that is not
  public, or `localhost`, checked without DNS; P8.5), `FETCH_IP_LITERAL`
  (a public IP-literal host, which P8.5 also refuses), `FETCH_REDIRECT`
  (redirects are never followed), `FETCH_STATUS`, `FETCH_TOO_LARGE`,
  `FETCH_TIMEOUT` (`timeoutMs`, covering headers and body), `FETCH_ABORTED`
  and `FETCH_FAILED`, all `unavailable-bytes`. It sends no credentials and
  skips the HTTP cache. With `origin` (local development) only the URL's
  path and query are set on that origin, which is trusted as given.
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
