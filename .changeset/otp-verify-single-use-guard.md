---
"@originals/auth": patch
---

Add a single-use guard to `verifyEmailAuth` so it can no longer be re-run on an already-verified or in-flight session (#710).

Closes #710, closes #819.

Previously, `verifyEmailAuth` never checked `session.verified` (or any in-flight marker) before running its full OTP-verify round trip, so a second call with the same `sessionId` and OTP code re-submitted the already-consumed OTP to Turnkey and minted a second, independent verification token (and a second ephemeral keypair on the server-fallback path). A new `session.verifying` claim, set synchronously before the first `await`, now rejects both a sequential replay on an already-verified session and a concurrent replay racing the same unverified session within one process, and is released on any failure path that leaves the session alive so a corrected retry still succeeds.

`SessionStorage` also gains an optional `claimForVerification(sessionId)` method. When a `SessionStorage` implementation provides it, `verifyEmailAuth` uses it instead of the get-then-set fallback above, so a shared, multi-instance store (Redis, a database) can make the claim genuinely atomic across processes by implementing it with a real conditional write (e.g. a Redis `WATCH`/`MULTI` or Lua script, or a SQL `UPDATE ... WHERE verifying = false`). `createInMemorySessionStorage` implements it trivially (it's already a single process's `Map`). Without it, a shared store falls back to the single-process-only guarantee described above; full cross-instance replay-safety for a store that doesn't yet implement it is coordinated with the broader async-storage work tracked in #684.

The same claim closes #819 as a side effect: only the caller that wins the claim ever dispatches to Turnkey's `verifyOtp`, so a burst of concurrent wrong-code guesses for one session can no longer race past the local `MAX_OTP_ATTEMPTS` backstop — at most one guess is ever in flight to Turnkey per session, instead of `MAX_OTP_ATTEMPTS` only being checked reactively after each round trip.
