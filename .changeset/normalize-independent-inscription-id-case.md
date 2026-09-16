---
"@originals/cel": patch
"@originals/sdk": patch
---

**`resolveSat`'s independent-enumeration/content cross-check now normalizes inscription id hex casing before comparing, matching the existing `normalizeSatpoint` treatment for satpoints.** (#808)

The `independentEnumeration.inscriptionIds` membership check and the `independentContent` id lookup both compared inscription ids (`<64-hex-txid>i<index>`) verbatim, with no case normalization — unlike the sibling satpoint comparison a few lines below, already fixed by #751 via `normalizeSatpoint`. A second, independently-configured index that reported the same underlying inscription using a different (equally valid) hex-case convention for the txid was treated as disagreeing: the enumeration check failed closed with `inconsistent-evidence`, and the content-assurance check silently missed the match, leaving assurance at `provider-asserted` instead of `cross-checked`.

Added `normalizeInscriptionId` (`packages/cel/src/v3/publications.ts`), mirroring `normalizeSatpoint`: it lowercases the txid and the `i` separator, and returns non-matching values unchanged so a genuinely malformed id still fails comparison. Applied at all three cross-check sites (`known` enumeration set, `independentContentById` map build, and its lookup by the primary snapshot's `publication.id`).
