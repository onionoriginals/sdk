---
"@originals/auth": minor
---

**`verifyEmailAuth` no longer collapses a transient `verifyOtp` failure (network blip, timeout, unexpected response shape) into the same outcome as a genuinely wrong OTP code** (#747).

Previously, any `verifyOtp` rejection — a real Turnkey rejection of the submitted code, or a transport failure that never reached Turnkey's enclave at all — threw the same untyped `Error` and consumed the same `MAX_OTP_ATTEMPTS` budget. A Turnkey outage or network blip during the 15-minute OTP window could therefore exhaust a legitimate user's attempt budget and lock them out, even though they never typed a wrong code.

`verifyEmailAuth` now distinguishes the two cases using the numeric `.code` Turnkey's own JSON error response carries (present on a genuine rejection, absent on a transport failure), and throws a `StructuredError` with one of three new exported codes (`OTP_VERIFY_ERROR_CODES` from `@originals/auth/server`):

- `AUTH_OTP_CODE_INCORRECT` — Turnkey evaluated and rejected the code; consumes an attempt, same as before.
- `AUTH_OTP_VERIFY_TRANSIENT_FAILURE` — code correctness was never evaluated; does **not** consume an attempt, so the caller can retry with the same code.
- `AUTH_OTP_ATTEMPTS_EXCEEDED` — the incorrect-code attempt budget is spent; session destroyed, same as before.

Existing error messages for the incorrect-code and attempts-exceeded paths are unchanged.
