---
"@originals/auth": patch
---

**`getOrCreateTurnkeySubOrg` now repairs a stale pre-#748 Ethereum-formatted Bitcoin auth-key account in place, and no longer swallows a transient wallet-check failure into a false "login succeeded" result** (#749, #805).

The existing-sub-org account-role repair added for #784 matched a required role by `curve` + `path` alone, so a sub-org provisioned before #748's fix — which still carries a `CURVE_SECP256K1` account at the Bitcoin auth-key path with the old `ADDRESS_FORMAT_ETHEREUM` — was wrongly treated as already having the `bitcoin-auth` role and never repaired. The comparison now also requires `addressFormat` to match, consistent with `turnkey-roles.ts`'s `getKeyByRole`, so the corrected `ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR` account is added in place (Turnkey accounts are immutable, so the stale account is left alongside it, not replaced).

Separately, the wallet-existence check (`getWallets`) in the same function caught **any** error — network blip, timeout, rate limit — and returned the existing sub-org ID as if a wallet had been found, without creating/repairing anything and without surfacing the failure. `getWallets` has no legitimate not-found case (a walletless sub-org is a successful empty `{ wallets: [] }` response), so any thrown error now propagates as a `StructuredError` instead.
