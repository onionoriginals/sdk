---
"@originals/landing": patch
---

Fix `GET /api/btc/inscribe`'s `settled` flag reporting `true` for a `confirmed` record whose on-disk `confirmations` already meets the recovery threshold but whose `retire()` call hasn't run yet, before its recovery artifacts are actually gone (#777).
