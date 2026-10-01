---
"@originals/auth": patch
---

**Fix (#684): `SessionStorage`'s `get`/`set`/`delete`/`cleanup` now support a Promise-returning implementation.** The interface was declared fully synchronous and `email-auth.ts` called it without `await`, even though the package's own docs recommend a persistent Redis/DB-backed store for production and `specs/auth/authentication-flows.md` documents exactly that. A real async store's `get()` returns a `Promise`, which is truthy, so `verifyEmailAuth`'s "session not found" guard never fired and every field read off the unresolved Promise came back `undefined` (surfacing as a misleading `"OTP ID not found in session"` error); an unawaited `set()` also let `initiateEmailAuth` return before an async write had landed.

Every `SessionStorage` method is now typed `T | Promise<T>`, and all call sites `await` the result. `isSessionVerified`, `getSession`, and `cleanupSession` are now `async` (previously synchronous), since they call `storage.get`/`delete` internally — existing callers using them without `await` will start receiving a `Promise` instead of the resolved value. `createInMemorySessionStorage` is unaffected: a synchronous return still satisfies the widened interface.
