---
"@originals/landing": patch
---

Fix the inscriptions-list `settled` field reporting `true` for a `confirmed` record whose on-disk `confirmations` already reached the recovery threshold but that was never actually `retire()`d, because the reconciliation pass's shared per-poll lookup budget hadn't reached its turn yet (#777).

The list mapper in `bitcoin-reconciliation.ts` computed `settled: r.retired === true || (r.confirmations ?? 0) >= RECOVERY_CONFIRMATIONS`, an `OR` that disagreed with the resubmission endpoint (`bitcoin.ts`), which already uses the strict `settled: rec.retired === true`. The mapper now uses the same strict check, so a record whose recovery hex is still on disk is never reported settled ahead of its actual retirement.
