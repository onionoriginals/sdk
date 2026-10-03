---
"@originals/cel": patch
---

**`parseAssetAlias` no longer rejects a `did:webvh` path segment containing a tilde (`~`) in every spelling.** A literal `~` is still rejected (RFC 3986 treats it as unreserved, but DID Core's `idchar` grammar does not permit a literal `~` in a method-specific id), but its canonical percent-encoded spelling (`%7E`) is now accepted, and is mapped to a literal `~` in the resulting WebVH HTTPS log path — matching the WebVH method's own RFC 3986 path transformation. Previously the percent-encoded form passed the raw allow-list but was then rejected as "noncanonical" because the canonicalizer re-encoded it back to a bare `~`, so no spelling of a tilde path segment (e.g. a personal-namespace path like `~alice`) could ever be accepted, including through a `migrate` fold.
