---
"@originals/auth": minor
---

`sendOtp`/`verifyOtp` (from `@originals/auth/client`) now throw an `AuthApiError` (extends `Error`) instead of a bare `Error` on a non-ok server response. `message` behavior is unchanged for existing callers; `AuthApiError` additionally carries `status` (the HTTP status) and `code` (the server's machine-readable `error` field, when present), so a caller can branch on the failure kind instead of parsing display text. This pairs with the landing app's `auth-routes.ts`, which now returns `{ error: 'invalid_email' | 'rate_limited' | 'send_otp_failed' | 'missing_fields' | 'verification_failed' | 'unauthorized' | 'invalid_token', message }` on every named failure instead of `{ message }` only.
