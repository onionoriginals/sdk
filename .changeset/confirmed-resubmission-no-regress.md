---
"@originals/landing": patch
---

Fix `POST /api/btc/inscribe` regressing a `confirmed`-but-not-yet-`retired` signed commit+reveal pair's stored status when resubmitted (#755).
