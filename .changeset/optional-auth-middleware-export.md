---
"@originals/auth": patch
---

**`createOptionalAuthMiddleware` is now exported from `@originals/auth/server`** (#730).

It was implemented and documented in `server/middleware.ts` (and in `server/index.ts`'s own module doc comment) alongside `createAuthMiddleware`, but only `createAuthMiddleware` was actually re-exported from the package's public entry point. `import { createOptionalAuthMiddleware } from '@originals/auth/server'` resolved to `undefined` at runtime, forcing consumers onto the undocumented deep-import path `@originals/auth/server/middleware` instead of the package's stable public surface.
