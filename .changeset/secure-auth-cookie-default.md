---
"@originals/auth": patch
---

**`getAuthCookieConfig`/`getClearAuthCookieConfig` now default `secure: true` unconditionally**, instead of inferring it from `process.env.NODE_ENV === 'production'` (#676).

Not every deployment platform sets `NODE_ENV` to exactly `"production"`, so the previous default silently shipped the 7-day auth JWT cookie without `Secure` on any platform that doesn't. Pass `{ secure: false }` explicitly to opt back out for local plain-HTTP development — that escape hatch is unchanged, on both the set and the clear cookie config.
