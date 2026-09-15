---
"@originals/landing": patch
---

Fix two TOCTOU races (#677, #694) where a background/concurrent reconciliation pass could clobber another pass's result for the same inscription record.

`bitcoin-reconciliation.ts`'s reorg-demotion decision read the top-of-function record snapshot instead of the fresh per-record read taken just before its own provider round trip, so a record confirmed by a concurrent `reconcileUser` call (an overlapping poll, or the background sweep) mid-pass could be left incorrectly reporting `confirmed` on stale reorg evidence instead of being demoted. `inscription-completion-sweep.ts` had the mirror-image bug: it wrote `reveal_broadcast` unconditionally after its own status lookup/broadcast, which could regress a record a concurrent pass had already confirmed or retired.

- `InscriptionsStore` gains `trySetStatus`: a guarded status transition that only writes if the record's on-disk `status`/`retired`/`superseded` still match what the caller last observed, returning whether the write applied. Both files now use it wherever a status decision follows an `await`, so a concurrent pass's result is never silently overwritten.
- `bitcoin-reconciliation.ts`'s `liveStuck`/`liveUnconfirmed` passes now read the fresh per-record snapshot throughout (not the stale top-of-pass one) and write through `trySetStatus`.
- `inscription-completion-sweep.ts` now refuses to advance a record that raced out from under it, logging a new `inscription_sweep_raced` money event instead of clobbering the concurrent result.
