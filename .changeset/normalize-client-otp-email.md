---
"@originals/auth": patch
---

**Client-side `initOtp` now normalizes email (trim + lowercase) before calling Turnkey**, matching the server flow (#737).

Turnkey sub-org lookup filters on the exact `contact` string. `getOrCreateTurnkeySubOrg`/`initiateEmailAuth` already normalized email before every server-side Turnkey call for that reason, but the direct client `initOtp` helper sent the caller-supplied email through verbatim — so a user could be routed to two different Turnkey sub-orgs for differently-cased/padded spellings of the same mailbox. `normalizeEmail` now lives in an isomorphic `packages/auth/src/email.ts`, re-exported from `server/turnkey-client.ts` for compatibility.
