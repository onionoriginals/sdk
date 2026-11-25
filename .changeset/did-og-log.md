---
"@originals/vh": minor
---

Add `@originals/vh/og`, the did:og 1.0 core (method value `og:1.0-draft.1`,
originals-spec PR 69 at 6e0e3f9), starting with its log format: the
`did.jsonl` line format (P14.2), strict JSON with the 2^53 − 1 number bound
(P14.3), the entry shape (P14.27), SCID and entry hash (P14.28, P14.29), the
parameters an entry may carry with `updateKeys` always `[]` (P14.1), the
one-proof shape (P14.8) and the writer that prepares and signs genesis and
later entries. Reproduces the spec's genesis vector byte for byte (T14-091).
