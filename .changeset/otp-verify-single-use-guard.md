---
"@originals/auth": patch
---

Add a single-use guard to `verifyEmailAuth` so it can no longer be re-run on an already-verified or in-flight session (#710).

Previously, `verifyEmailAuth` never checked `session.verified` (or any in-flight marker) before running its full OTP-verify round trip, so a second call with the same `sessionId` and OTP code re-submitted the already-consumed OTP to Turnkey and minted a second, independent verification token (and a second ephemeral keypair on the server-fallback path). A new `session.verifying` claim, set synchronously before the first `await`, now rejects both a sequential replay on an already-verified session and a concurrent replay racing the same unverified session within one process, and is released on any failure path that leaves the session alive so a corrected retry still succeeds.

This closes the replay within a single server process. It does not make the claim atomic across multiple instances sharing one `SessionStorage` (e.g. Redis) — `SessionStorage` is synchronous by contract, so a shared store still can't offer a true compare-and-swap through this interface. Cross-instance replay-safety needs `SessionStorage` to become async and CAS-capable, tracked separately in #684.
