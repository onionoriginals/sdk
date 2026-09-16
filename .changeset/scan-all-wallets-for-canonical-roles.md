---
"@originals/auth": patch
---

Fix `ensureWalletWithAccounts` duplicating canonical Turnkey accounts (`bitcoin-auth`, `did-assertion`, `did-update`) that already exist in a different wallet within the same sub-org (#765).

The function only checked `wallets[0].accounts` when deciding which required roles were missing. If a sub-org had multiple wallets and a role already existed in a wallet other than the first, it was wrongly treated as missing, and a brand-new, differently-keyed duplicate account was created in `wallets[0]`. Since `getKeyByRole`/`getKeyByCurve` resolve roles across every wallet in the sub-org, this could cause downstream lookups to silently diverge from whichever key was actually enrolled elsewhere (e.g. bound into a DID document's verification methods).

Missing roles are now computed against every wallet's accounts (`wallets.flatMap`), matching how `getKeyByRole` already scans the whole sub-org.
