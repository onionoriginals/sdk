---
"@originals/cel": patch
"@originals/sdk": patch
---

One WebVH path-segment rule, owned by `@originals/cel`, now guards every `paths`-taking authoring seam.

`@originals/cel/v3` (and `@originals/sdk/cel`) export `isWebVHPathSegment`, the decoded-segment predicate `parseAssetAlias` applies (non-empty, not `.`/`..`, no `/`, `\`, NUL or leading/trailing whitespace, well-formed UTF-16), and `canonicalWebVHPaths`, which validates a `paths` array, reserves a leading `.well-known` (any case) and returns the DID-spelling segments. `publishToWeb`, `sdk.did.createDIDWebVH`/`migrateToDIDWebVH` and `createDIDOriginal` (and so `@originals/auth`'s `createDIDWithTurnkey`) all use it before signing.

Behaviour changes: a segment with edge whitespace or a lone surrogate now fails `ASSET_WEBVH_PATH` / `WEBVH_PATH_SEGMENT_INVALID` instead of an uncoded didwebvh-ts `Error` or `URIError`; a colon inside a segment (`a:b`) is accepted and encoded `a%3Ab`; `createDIDOriginal` now percent-encodes its segments and rejects invalid, non-array and reserved `paths` instead of minting a DID `parseAssetAlias` cannot read. `parseAssetAlias` still reads existing `.well-known` DIDs. The unreleased SDK helper `isValidWebVHPathSegment` is removed in favour of the CEL predicate.
