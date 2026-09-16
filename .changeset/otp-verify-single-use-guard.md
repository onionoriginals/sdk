---
"@originals/auth": patch
---

Add a single-use guard to `verifyEmailAuth` so it can no longer be re-run on an already-verified or in-flight session (#710).

Previously, `verifyEmailAuth` never checked `session.verified` (or any in-flight marker) before running its full OTP-verify round trip, so a second call with the same `sessionId` and OTP code re-submitted the already-consumed OTP to Turnkey and minted a second, independent verification token (and a second ephemeral keypair on the server-fallback path). A new `session.verifying` claim, set synchronously before the first `await`, now rejects both a sequential replay on an already-verified session and a concurrent replay racing the same unverified session, and is released on any failure path that leaves the session alive so a corrected retry still succeeds.
