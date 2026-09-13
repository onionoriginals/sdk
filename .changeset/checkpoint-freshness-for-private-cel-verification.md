---
"@originals/sdk": minor
"@originals/cel": minor
---

Add a portable `checkpoint`/`freshness` contract to CEL 3 `verifyHistory`, addressing #607.

`verifyHistory`'s existing `prefix` option only authenticates continuation within
one verifier instance (a `WeakSet`-tracked object), so it cannot detect rollback
or a diverging continuation once history crosses a process boundary — for
example, a private (non-Bitcoin-anchored) CEL a holder re-presents after time
has passed. `checkpointFromHistory(history)` now extracts a portable, JSON-safe
`{ assetId, head, entryCount }` claim a caller can persist or hand to a
different verifier. Passing it back as `verifyHistory(log, { checkpoint })`
independently confirms the presented history equals or extends that checkpoint
— never trusting the checkpoint's own say-so — and fails closed
(`CEL_CHECKPOINT_ASSET`, `CEL_CHECKPOINT_ROLLBACK`, `CEL_CHECKPOINT_FORK`) on a
wrong asset, rollback, or fork/equivocation.

`VerifiedHistory` gains a `freshness` field (`"unknown" | "checkpoint-consistent"
| "externally-anchored"`), reported separately from signature-chain
authentication. It is `"unknown"` whenever no checkpoint is supplied, so a
first-time verifier's result still never implies it has seen the latest state.
`"externally-anchored"` is reserved for future witness/Bitcoin-anchoring
evidence and is not produced by this change. Persisting a checkpoint, and
deciding when its absence should block an operation, remains an
application/recipient policy choice.
