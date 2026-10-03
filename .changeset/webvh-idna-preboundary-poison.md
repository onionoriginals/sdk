---
"@originals/cel": patch
"@originals/sdk": patch
---

`resolveSat` no longer lets an unrelated party permanently block resolution of
a sat by inscribing their own self-signed history whose `migrate` operation
targets an unsupported IDNA WebVH domain (`CEL_WEBVH_IDNA`), when that
candidate arrives before any boundary has been selected for the sat.

`apply()`'s controller-authority check (`CEL_AUTHORITY`) only proves an entry
is signed by *some* controller: with no `prefix` supplied (no boundary
selected yet), that controller is the candidate's own self-declared `create`
controller, not this Original's real controller. Treating every
`CEL_WEBVH_IDNA` throw as an authenticated, poisoning continuation — as the
pre-existing code did unconditionally — let anyone author a throwaway,
internally self-consistent history with an invalid IDNA domain and, once
confirmed at a lower block height/position than the real boundary, flip the
whole sat's resolution to `unsupported-capability` forever.

`CEL_WEBVH_IDNA` now only poisons resolution once a boundary has actually
been accepted (`history !== undefined`), matching the existing
`CEL_DATA_REFERENCE` guard's `candidateAuthenticatedContinuation` reasoning:
a pre-boundary candidate remains exactly as ignorable as any other invalid
one, per `specs/originals-cel-v3-authority.md`'s "does not poison an
otherwise valid history" rule.
