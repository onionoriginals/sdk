---
"@originals/landing": patch
---

Fix `POST /api/btc/inscribe` durably regressing an already `reveal_broadcast` signed commit+reveal pair's stored status to `commit_broadcast` when a resubmission's redundant reveal re-push fails with a transient, non-"already known" error (#865).
