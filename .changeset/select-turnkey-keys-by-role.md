---
"@originals/auth": patch
---

**`getKeyByRole` selects a Turnkey wallet account by curve + exact derivation path, distinguishing the DID assertion-key from the update-key** (#744).

`getKeyByCurve(wallets, 'CURVE_ED25519')` always returned the first matching account, so it could never reach the second of the package's two `CURVE_ED25519` accounts (assertion-key at `m/44'/501'/0'/0'`, update-key at `m/44'/501'/1'/0'`). `ensureWalletWithAccounts` had the same blind spot at the completeness-check layer: it counted accounts per curve, so a wallet with two Ed25519 accounts at the *wrong* paths was miscounted as already complete.

Added `getKeyByRole(wallets, role)` and the exported `TURNKEY_ACCOUNT_ROLES` table (`'bitcoin-auth' | 'did-assertion' | 'did-update'`, each with its curve/path/address format) as the source of truth for both `createWalletWithAccounts` and `ensureWalletWithAccounts`, which now check each required role by exact path instead of by curve count. `getKeyByCurve` is unchanged and still supported.
