---
"@originals/auth": patch
---

**Server-side Turnkey sub-org provisioning now assigns the secp256k1 "Bitcoin auth-key" account a Bitcoin address format instead of an Ethereum one** (#689).

`DEFAULT_WALLET_ACCOUNTS` in `server/turnkey-client.ts` provisioned its `m/44'/0'/0'/0/0` account — its own comment labels it "Bitcoin path for auth-key" — with `ADDRESS_FORMAT_ETHEREUM`, while the identical curve/path account in `client/turnkey-client.ts` already used `ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR`. `getOrCreateTurnkeySubOrg` is the function `apps/landing`'s email-auth flow actually calls to provision real user sub-orgs, so every user's Bitcoin auth-key account was getting an Ethereum-formatted `.address` for a key meant for Bitcoin funding and sat verification.
