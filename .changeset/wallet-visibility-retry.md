---
"@originals/auth": patch
---

Retry successful wallet reads with bounded backoff when a newly created wallet is not yet visible. Report the created wallet ID on exhaustion without implying creation failed, and propagate authentication and backend errors without retrying creation or failed reads.
