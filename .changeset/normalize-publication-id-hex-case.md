---
"@originals/cel": patch
---

**`resolveSat`'s `publication.id` self-consistency check now normalizes hex casing before comparing, matching the existing `revealTxid`/`block.txids` treatment.** (#857)

`resolveSat` compares `publication.id`'s parsed txid against `normalizeTxid(publication.revealTxid)` — but only normalized the `revealTxid` side. `publication.id` itself was run through a lowercase-only regex with no normalization first, so a provider reporting `publication.id` in a different (still valid) hex case than `revealTxid` made the regex fail to match at all, hard-failing the *entire* `resolveSat` call with `inconsistent-evidence` instead of a per-candidate skip — even for an otherwise fully valid, fully signed publication.

Applied the existing `normalizeInscriptionId` helper (already used for the independent-enumeration/content cross-check added by #808) to `publication.id` before the regex match, mirroring the sibling `revealTxid`/`block.txids` fixes from #821. A malformed `publication.id` still fails comparison, since `normalizeInscriptionId` returns non-matching values unchanged.
