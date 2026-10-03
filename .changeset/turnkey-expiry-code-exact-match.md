---
"@originals/auth": patch
---

**Turnkey session-expiry detection no longer false-positives on an error code numerically prefixed by `16`** (#800).

`withTokenExpiration()` detected an expired session with `errorStr.includes('"code":16')` — an unanchored substring match against serialized error text, not a check that the `code` field equals `16`. Any error whose `code` merely started with the digits `16` (e.g. `160`, `1601`) was misclassified as session expiry: the real error was discarded, replaced with `TurnkeySessionExpiredError`, and `onExpired()` fired for an error unrelated to authentication. `withTokenExpiration()` now walks the error (and its `cause` chain) structurally and only treats an exact `code === 16` (or `"16"`) as the gRPC `UNAUTHENTICATED` marker; the two textual markers (`api_key_expired`, `expired api key`) are unchanged.
