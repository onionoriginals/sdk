---
"@originals/auth": patch
---

**`verifyEmailAuth` now claims a session synchronously before dispatching to Turnkey, closing a concurrency gap that let concurrent OTP guesses bypass `MAX_OTP_ATTEMPTS`** (#819).

`MAX_OTP_ATTEMPTS` was only ever charged reactively, after a `verifyOtp` rejection came back. Nothing stopped several concurrent `verifyEmailAuth` calls for the same session from all reaching Turnkey before any of them recorded a failed attempt, so a burst of concurrent guesses could exceed the intended 5-attempt local brute-force cap. `verifyEmailAuth` now sets a `session.verifying` flag synchronously — before its first `await` — so only the first of any concurrent calls for a session proceeds to Turnkey; every other concurrent call is rejected immediately with a new `AUTH_OTP_VERIFY_IN_PROGRESS` error and never counts against the attempt budget. The claim is released whenever the session survives a failed attempt (transient failure, encryption failure, or an incorrect code under the budget) so a corrected retry still works.
