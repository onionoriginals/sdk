---
"@originals/landing": patch
---

Fix a TOCTOU race (#762) in `POST /api/btc/inscribe`'s rival-confirmation check: it wrote the rival's status with an unguarded `setStatus` after awaiting `provider.getTransactionStatus`, so a concurrent reconciliation pass that legitimately confirmed the same rival (with real confirmation depth/block evidence) while that lookup was in flight could have its `'confirmed'` status silently downgraded back to `'commit_broadcast'`, wiping its confirmations.

The write now goes through the existing guarded `trySetStatus`, expecting the still-`'signed'` state this branch already observed, matching the pattern used for the same defect class elsewhere in this codebase (#758/#694/#677). On a CAS miss no retry is needed: the fresh provider result still proves the rival won the outpoint, so the request keeps refusing with 409 while leaving the concurrent pass's newer state untouched.
