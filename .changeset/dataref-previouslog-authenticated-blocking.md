---
"@originals/cel": patch
"@originals/sdk": patch
---

Fix a permission-less denial-of-service in `resolveSat`'s handling of the CCG
`dataReference` shape: it no longer treats a candidate as an
`unsupported-capability` block on the strength of its raw, unauthenticated
`previousEvent` string alone. `eventShape`/`validateDocument` reject this
shape before any proof is ever inspected, so anyone without the sat's
controller key could previously force a permanent `unsupported-capability`
result for a real Original by inscribing a single candidate whose
`previousEvent` merely claimed to match the accepted head, with an empty,
invalid, or wrong-controller proof — including by appending an unsigned
`dataReference` entry after an unrelated, genuinely controller-signed one,
since a proof only ever signs its own event, never the whole log.
`resolveSat` now independently authenticates the entire prefix leading up to
the offending entry (signature, chain linkage and controller authority,
including any rotation among them) and the offending entry's own signature
against the resulting controller, before it may block resolution; otherwise
the candidate remains exactly as ignorable as any other invalid one, and the
already-accepted history is reported normally. `CEL_WEBVH_IDNA` is
unaffected: it can only be thrown after the entry's signature and controller
authority have already been authenticated inside `apply()`.

`CEL_PREVIOUS_LOG` is always treated as ignorable, and is deliberately not
given the same authenticated-blocking treatment as `dataReference`: unlike
`dataReference` (embedded inside the signed operation) or `CEL_WEBVH_IDNA`
(reachable only after full signature authentication), the `previousLog`
wrapper is a document-level construct that sits entirely outside any signed
event, and its own proof has no CCG-specified target. Authenticating only
the *wrapped* log would not establish that the controller authorized the
wrapping itself — anyone can wrap a copy of any log, controller-signed or
not, in a `previousLog` envelope, which would let a permissionless observer
flip a resolution from `accepted` to `unsupported-capability` at will.
Originals 3 itself never produces `previousLog` documents, so this does not
blind resolution to any real writer output.
