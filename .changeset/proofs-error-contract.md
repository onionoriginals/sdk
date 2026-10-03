---
"@originals/cel": patch
"@originals/sdk": patch
---

`jcsSigningMessage` now reports an unsupported signing algorithm with
`status: 'unsupported'`, matching `createLocalSigner` and `signEvent`, which
already reported the identical condition that way. Previously
`jcsSigningMessage` routed the check through `requireThat`, which can only
ever emit `status: 'invalid'`, so the same public `@originals/cel/v3`
function family reported two different `FailureStatus` values for one
semantic condition (#700).

`verifyJcsSignature` now validates the supplied signature's byte length
against its controller's algorithm before calling into `@noble/curves`,
throwing a `CelError('invalid', 'CEL_SIGNATURE', ...)` for a wrong-length
signature instead of letting a raw, unwrapped `RangeError` escape this public
verification boundary. A correctly-shaped but cryptographically wrong
signature still returns `false`, unchanged (#725).
