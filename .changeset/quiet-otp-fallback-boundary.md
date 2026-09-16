---
"@originals/landing": patch
---

Fix `POST /api/auth/verify-otp` returning a permanently dead `verificationToken` when the request omitted a client-held `publicKey` (#708).

`verifyEmailAuth` documents a server-side fallback: when no client `publicKey` is supplied, it generates an ephemeral P-256 keypair itself and returns the resulting `privateKey` in its result — explicitly for server-only callers, since that private key should never transit an HTTP response. The landing route never returned this `privateKey` field, but it also ignored which case it was in and always echoed back `verificationToken`/`publicKey` regardless of who generated the keypair, so the server-fallback path silently handed the caller a token bound to a public key whose matching private key it never received, while still reporting `verified: true`.

`verifyOtp` now only includes `verificationToken`/`publicKey` in the response when the request itself supplied a client-held `publicKey` (the case where the token is safe to return, since the caller already holds the matching private key). Otherwise it reports cookie-auth only — the session cookie still authenticates the caller either way.
