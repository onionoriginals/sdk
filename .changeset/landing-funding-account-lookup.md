---
"@originals/landing": patch
---

**Fix: the Bitcoin funding account is found instead of re-created every sign-in.**

Every sign-in after the first failed with:

```
create_wallet_account {"code":6,"message":"path already exists in wallet account …"}
```

`ensureBitcoinFundingAccount` looked for the existing account by reading
`wallet.accounts` off `getWallets`. Turnkey's `v1Wallet` has no `accounts`
field — it returns wallet metadata only, and accounts come from
`getWalletAccounts`. So the lookup was always `undefined`, the account was
never found, and the first sign-in created it while every later one tried to
create the same BIP-32 path again.

The path is fixed, so re-reading returns the same address a previous session
created — which matters, because a creator may already have BTC sitting at it.

Also made genuinely idempotent rather than only claiming to be: if creation
reports the path already exists, that is itself proof the account is there, so
it re-reads and returns it rather than failing a sign-in over an account that
already works. And the network-prefix check now covers a re-read account, not
just a freshly created one.
