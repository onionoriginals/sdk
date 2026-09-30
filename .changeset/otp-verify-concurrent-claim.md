---
"@originals/auth": patch
---

**`verifyEmailAuth` now claims a session before verifying its OTP code, closing both a replay gap and a concurrent brute-force gap** (#710, #819).

Previously, `verifyEmailAuth` never checked `session.verified` before running a full OTP-verify round trip, so a second call with the same `sessionId` and code re-submitted the already-consumed OTP to Turnkey and minted a second, independent verification token (#710). Separately, `MAX_OTP_ATTEMPTS` was only checked reactively — after a failed `verifyOtp` round trip — so a burst of concurrent wrong-code guesses for one session could all reach Turnkey before any of them incremented the local attempt counter, bypassing the documented local brute-force cap (#819).

A new `session.verifying` claim, set synchronously before the first `await`, now rejects a sequential replay on an already-verified session and serializes concurrent calls racing the same unverified session — only the claim winner ever dispatches to Turnkey, so at most one guess is in flight per session at a time. The claim is released on any failure path that leaves the session alive (a failed encryption attempt, a transient Turnkey failure, or a definitively wrong code within budget), so a corrected retry still works.

`SessionStorage` gains an optional `claimForVerification(sessionId)` method so a shared, multi-instance store (Redis, a database) can make the claim atomic across processes via a real conditional write; `createInMemorySessionStorage` implements it trivially. Without it, a shared store keeps the existing single-process-only guarantee.
