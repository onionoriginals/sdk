---
"@originals/landing": patch
---

Fix `isAuthorizedReinscription` failing closed on a legitimate reinscription when the configured `OrdinalsProvider` reports the satpoint's txid in a different (but still valid) hex case than the caller's declared identity (#811).

`isAuthorizedReinscription` compared `resolveSat`'s pass-through of the raw provider snapshot's `ownership.satpoint` verbatim against a locally-built, only-partially-lowercased expected satpoint. `ownership.satpoint` carries no casing contract of its own, so a provider spelling the reveal txid in different hex case than `input.identity.txid` made an otherwise fully authorized, correctly-placed CEL continuation rejected as "wrong sat." Both sides are now normalized with the existing `normalizeSatpoint` helper, mirroring the sibling sites already fixed by #751.
