---
"@originals/auth": patch
---

**Fixed a TOCTOU race in `getOrCreateTurnkeySubOrg` that could mint two Turnkey sub-organizations for one email** (#728).

Two concurrent calls for the same brand-new email (two tabs completing OTP verification close together, or a client retry overlapping an in-flight request) could both observe an empty sub-org lookup and both create a sub-organization, forking the user's identity. `getOrCreateTurnkeySubOrg` now serializes its lookup-then-create sequence per normalized email via a new `SubOrgLock`. The default is an in-process lock (`createInProcessSubOrgLock`), sufficient for a single server instance; multi-instance deployments should inject a distributed `SubOrgLock` (e.g. Redis-backed) via `verifyEmailAuth`'s new `subOrgLock` option or directly as `getOrCreateTurnkeySubOrg`'s third argument.
