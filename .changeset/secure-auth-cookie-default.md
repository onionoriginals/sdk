---
"@originals/auth": major
---

**Breaking: `getAuthCookieConfig`/`getClearAuthCookieConfig` now default `secure: true` unconditionally**, instead of inferring it from `process.env.NODE_ENV === 'production'` (#676).

Not every deployment platform sets `NODE_ENV` to exactly `"production"`, so the previous default silently shipped the 7-day auth JWT cookie without `Secure` on any platform that doesn't. That was the bug this closes — but it also means any consumer currently serving over plain HTTP without passing an explicit `secure` option will start receiving `Secure` cookies, which browsers drop on a non-HTTPS origin, breaking auth. Pass `{ secure: false }` explicitly on **both** the set and the clear cookie config to keep the previous plain-HTTP behavior.
