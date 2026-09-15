---
"@originals/cel": patch
"@originals/sdk": patch
---

`resolveSat` now reports `status: 'unsupported-capability'` for a confirmed
publication carrying the CCG `dataReference` or `previousLog` shape, matching the
existing `CEL_WEBVH_IDNA` handling. Previously only `CEL_WEBVH_IDNA` was
recognized here; both `dataReference` and `previousLog` fell through to the
generic ignorable-candidate path and were silently dropped as diagnostics,
letting an already-accepted boundary's stale head be reported as fully
`accepted` even though a real, uninspectable continuation sat on the same sat.
Per `specs/originals-cel-v3-authority.md`, a recognized-but-unimplemented CCG
shape must never be treated as invalid or ignorable.

This does not broaden the check to every `status: 'unsupported'` error:
`CEL_PROFILE` (disallowed/missing Originals profile) and `CEL_SUITE`
(disallowed cryptosuite) are fully inspected, intentionally-rejected material,
not a recognized CCG shape this implementation merely cannot verify, and
remain on the existing ignorable-diagnostic path.
