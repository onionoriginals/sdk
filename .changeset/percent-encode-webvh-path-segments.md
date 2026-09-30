---
"@originals/cel": patch
"@originals/sdk": patch
---

Fix `WebVHManager.createDIDWebVH` minting a spec-noncanonical `did:webvh` when a caller-supplied `paths` segment contains a character such as `!`, `@`, `+`, or a space (#810).

`isValidPathSegment` only rejected directory-traversal characters (`.`, `..`, path separators, a leading `/`, a Windows drive prefix), so a segment containing an RFC 3986 sub-delimiter or reserved character passed validation but was handed to `didwebvh-ts` verbatim. The resulting DID failed CEL's `parseAssetAlias` allow-list on the very first publish (`CEL_DID: Invalid WebVH path component`), even though the same segment had just been accepted as valid.

`@originals/cel/v3` (and `@originals/sdk/cel`) now export `encodeWebVHPathSegment`, the canonical DID-spelling percent-encoding `parseAssetAlias` already computes when reading a WebVH path segment back, and `WebVHManager.createDIDWebVH` encodes each validated segment with it before constructing the DID — so a segment that passes `isValidPathSegment` now always produces a DID that CEL's own parser can read back. `paths` values are **decoded** input: a segment you pre-encoded yourself (`hello%21world`) is encoded again (`hello%2521world`). The HTTPS-spelling helper stays module-private.
