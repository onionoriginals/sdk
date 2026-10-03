---
"@originals/auth": patch
---

**Fix: `verifyEmailAuth` no longer loses failed-attempt counts with a shared `SessionStorage`.** It read the session before `claimForVerification` and charged the failed attempt against that pre-claim snapshot. With a store whose `get` returns a copy (Redis, SQL), a guess that claimed after an earlier failure had persisted wrote back the stale `otpAttempts`, so concurrent guesses could keep resetting the counter and bypass `MAX_OTP_ATTEMPTS`. The session is now re-read after a successful claim and that snapshot drives every check and the attempt count; a session that disappears or expires in between fails as `AUTH_SESSION_INVALID` / `AUTH_SESSION_EXPIRED` without calling Turnkey. A session missing its `otpId` or encryption target bundle is now deleted when rejected. `createInMemorySessionStorage` was not affected.
