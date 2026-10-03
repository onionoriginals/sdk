---
"@originals/auth": patch
---

Allow required and optional authentication middleware to verify custom JWT issuer and audience values while preserving defaults and rejecting mismatches. Keep successful next calls outside authentication error handlers so consumer errors do not trigger duplicate continuation.
