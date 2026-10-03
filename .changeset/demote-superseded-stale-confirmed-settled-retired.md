---
"@originals/landing": patch
---

Fix two independent causes of a stale `settled: true`/`confirmed` report for a Bitcoin inscription (#777).

The `supersededPending` reconciliation pass only ever handled positive evidence on a superseded pair's own commit (reclaim the outpoint once it confirms). A negative read was a silent no-op, so a record that reached `status: 'confirmed'` and was later superseded by a rival kept reporting `confirmed`/`settled: true` indefinitely, even after its own commit stopped confirming on a deeper reorg. The pass now demotes such a record to `reveal_broadcast` on real negative evidence, via a CAS-guarded write that keeps `superseded: true` (this pair already lost the outpoint race, so a negative read must never reclaim or reinstate it) and can't clobber fresher confirmation evidence a concurrent pass wrote while this pass's own lookup was in flight.

Independently, the inscriptions list mapper computed `settled` as `retired === true || confirmations >= RECOVERY_CONFIRMATIONS` — an `OR` that let a `confirmed` record whose on-disk confirmations already met the threshold (from an earlier pass, or the shared per-poll lookup budget not yet reaching its turn) report `settled: true` while `retired` was still `false` and its recovery hex was still on disk, disagreeing with the resubmission path's `settled: rec.retired === true` for the exact same record. `settled` now tracks `retired` alone.
