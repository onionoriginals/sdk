---
"@originals/auth": minor
---

`verifyToken` (from `@originals/auth/server`) now throws a `StructuredError` with a stable `code` — `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, or `AUTH_TOKEN_MISSING_SUBJECT` for a bad token, and `AUTH_JWT_CONFIG_SECRET_MISSING`/`AUTH_JWT_CONFIG_SECRET_WEAK` for a misconfigured server secret — instead of a bare `Error` that made the two indistinguishable. A new `isAuthTokenCredentialError(error)` helper reports whether an error is one of the credential-failure codes.

`createAuthMiddleware` and `createOptionalAuthMiddleware` use this to fix a correctness bug (#729): a valid JWT combined with a rejection from the caller-supplied `getUserByTurnkeyId`/`createUser` callback, or a misconfigured `JWT_SECRET`, previously read as bad credentials — `createAuthMiddleware` returned `401 { error: 'Invalid or expired token' }` and `createOptionalAuthMiddleware` silently continued as an anonymous guest. Both now call `next(error)` for these operational/config failures so they reach Express's error-handling middleware, while an actually invalid/expired/malformed token keeps its existing behavior (401, or anonymous continuation) unchanged.
