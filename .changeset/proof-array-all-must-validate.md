---
"@originals/cel": patch
"@originals/sdk": patch
---

`resolveSat`'s `entryExtendsUnderController` helper (used to decide whether a
CCG `dataReference` candidate is genuinely authenticated by the sat's current
controller) now requires every proof in a candidate's `proof` array to
validate and belong to the controller, instead of returning `true` as soon as
any single proof matched. Per `specs/originals-cel-v3-profile.md`'s
proof-array rule, "one valid proof does not excuse another invalid or
unsupported proof" — mixing a genuine current-controller proof with a
malformed, unsupported, or wrong-controller proof in the same array
previously still counted as authenticated, wrongly reporting
`unsupported-capability` (which stops evaluating further publications on the
sat) instead of ignoring the candidate and continuing. This mirrors the
all-or-nothing semantics `verifyEntry` already enforces in the real fold path.
