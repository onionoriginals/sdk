---
"@originals/auth": minor
---

**`packages/auth/src/server`'s remaining throw sites (`email-auth.ts`, `turnkey-client.ts`, `turnkey-signer.ts`) now throw `StructuredError` with a stable `code` instead of a bare `Error`** (#747).

This is the incremental follow-up #747 itself recommends after the JWT slice (#756): every server-side public function in `@originals/auth` — `initiateEmailAuth`, `verifyEmailAuth`, `createTurnkeyClient`, `getOrCreateTurnkeySubOrg`, and `TurnkeyWebVHSigner.sign` — now throws a `StructuredError` whose `.code` lets a caller do `catch (e) { if (e.code === 'X') ... }` instead of matching on `.message` text, matching the typed-error contract the rest of `@originals/sdk`'s public surface already follows. New exported code tables: `AUTH_EMAIL_ERROR_CODES`, `AUTH_TURNKEY_CLIENT_ERROR_CODES`, `AUTH_TURNKEY_SIGNER_ERROR_CODES`. `TurnkeyWebVHSigner.sign`'s failure wrap also now preserves the original error as `details.cause` (it previously dropped it, unlike every other Turnkey wrap site in this package). Error messages are unchanged, so existing message-matching callers are unaffected; `packages/auth/src/server/jwt.ts` was already converted separately in #756 and is untouched here.
