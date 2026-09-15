---
"@originals/auth": patch
---

**`getOrCreateTurnkeySubOrg` now repairs an existing sub-org's stale, pre-#748 Ethereum-formatted Bitcoin auth-key account in place** (#749).

Sub-orgs created before #748's fix have a `CURVE_SECP256K1` `m/44'/0'/0'/0/0` account provisioned with `ADDRESS_FORMAT_ETHEREUM` instead of `ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR`. #748 corrected new sub-orgs and walletless repairs, but left every already-provisioned wallet-bearing sub-org unchanged, so those users kept an Ethereum-formatted "Bitcoin auth-key" and continued to fail Bitcoin funding / sat-verification.

Since Turnkey wallet accounts are immutable, the repair adds a second `CURVE_SECP256K1` account at the identical curve/path with the corrected address format alongside the stale one — never mutating the stale account and never minting a replacement sub-org (the sub-org ID remains the user's stable identity).

Because a repaired wallet can then have two `CURVE_SECP256K1` accounts sharing a path, `TURNKEY_ACCOUNT_ROLES`/`getKeyByRole` (added in #744/#750) now also match on address format, not just curve + path, so `getKeyByRole(wallets, 'bitcoin-auth')` reliably resolves the corrected account. `ensureWalletWithAccounts` (`@originals/auth/client`) picks up the same fix: a stale account at the correct curve/path no longer satisfies the `bitcoin-auth` role, so it is repaired there too.
