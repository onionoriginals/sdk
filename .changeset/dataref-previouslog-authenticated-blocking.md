---
"@originals/cel": patch
"@originals/sdk": patch
---

Fix a permission-less denial-of-service in `resolveSat`'s handling of the CCG
`dataReference`/`previousLog` shapes: it no longer treats a candidate as an
`unsupported-capability` block on the strength of its raw, unauthenticated
`previousEvent` string alone. `eventShape`/`validateDocument` reject these two
shapes before any proof is ever inspected, so anyone without the sat's
controller key could previously force a permanent `unsupported-capability`
result for a real Original by inscribing a single candidate whose
`previousEvent` merely claimed to match the accepted head, with an empty,
invalid, or wrong-controller proof. `resolveSat` now independently verifies
that such a candidate's first entry is both extending the accepted head and
carries a genuine signature from the currently accepted controller before it
may block resolution; otherwise it remains exactly as ignorable as any other
invalid candidate, and the already-accepted history is reported normally.
`CEL_WEBVH_IDNA` is unaffected: it can only be thrown after the entry's
signature and controller authority have already been authenticated inside
`apply()`.
