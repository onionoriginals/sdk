---
"@originals/auth": patch
---

**`ensureWalletWithAccounts` no longer silently returns an incomplete wallet after repairing missing account roles** (#898). After calling `createWalletAccounts` to repair a missing role (e.g. the Bitcoin auth-key or a DID-signing key), the function re-read wallet accounts exactly once, with no delay and no retry, and returned whatever it got — even if the newly created role wasn't visible yet on that single read (a realistic eventual-consistency lag). No error was raised, so a caller had no signal that provisioning was actually incomplete, and could proceed into DID creation with a partial key set, or retry later and risk creating a duplicate account for a role whose earlier write simply hadn't propagated yet.

The post-repair re-read is now polled with a bounded number of retries (5 attempts, 500ms apart), and the function throws an explicit error naming the still-missing role(s) if they remain invisible once that window elapses, instead of returning silently.
