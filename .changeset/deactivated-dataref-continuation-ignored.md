---
"@originals/cel": patch
"@originals/sdk": patch
---

Fix a permanent, attacker-triggerable denial-of-resolution in `resolveSat`'s
CCG `dataReference` handling: a candidate that is genuinely authenticated by
the current controller but extends an already-**deactivated** head is now
ignored, exactly like any other candidate that cannot be a valid
continuation, instead of blocking the entire sat resolution closed with
`status: 'unsupported-capability'`.

Deactivation retires the asset's *authority*, not the controller's *key* —
per `specs/originals-cel-v3-authority.md`, no later authorship operation is
ever accepted after deactivation, unconditionally. Previously,
`candidateAuthenticatedContinuation` checked only that a `dataReference`
candidate extended the accepted head and carried a genuine signature from
the accepted controller; it never checked whether that accepted history was
already deactivated. Since the original controller's key remains valid even
after deactivation, that same controller could sign a `dataReference`
candidate over the deactivated head and permanently discard the
already-accepted, correctly-deactivated resolution in favor of
`unsupported-capability` — reachable through the default SDK's
`resolveAssetFromSat`/`resolveDID`, with no way to recover since the
poisoning inscription is immutable on-chain.
