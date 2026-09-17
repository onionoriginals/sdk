---
"@originals/landing": patch
---

Fix `GET /api/btc/inscribe` reporting `settled: true` for a `confirmed` record before its recovery artifacts were actually retired (#777).

The inscriptions list mapper computed `settled` as `r.retired === true || (r.confirmations ?? 0) >= RECOVERY_CONFIRMATIONS`, so a record whose on-disk `confirmations` already met the threshold — but whose turn the reconciler's rotating per-poll lookup budget hadn't yet reached — was reported settled while `store.retired` was still falsy and `signedCommitHex`/`revealTxHex` were still on disk, disagreeing with the resubmission path in `bitcoin.ts`, which already keys `settled` off `retired` alone. `settled` now reads `r.retired === true` only, matching that sibling path exactly.
