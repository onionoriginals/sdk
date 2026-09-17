---
"@originals/auth": patch
---

**`getOrCreateTurnkeySubOrg` no longer treats a transient failure checking an existing sub-org's wallet as fake success** (#805).

Unlike the sub-org lookup a few lines above it (which correctly rethrows anything that isn't a definitive not-found), the wallet-existence check caught **any** error — network blip, timeout, rate limit — logged it, and returned the sub-org ID as if a wallet had been found, silently skipping the walletless-repair path. `getWallets` has no legitimate "not found" case to special-case in the first place: a genuinely walletless sub-org is represented by a successful `{ wallets: [] }` response, so any thrown error here now propagates (wrapped with `cause`) instead of being swallowed.
