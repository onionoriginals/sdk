---
"@originals/sdk": patch
---

fix: accept `network: 'testnet'` in the `OriginalsSDK` constructor

`OriginalsConfig.network` has always included `'testnet'` and the entire
Bitcoin layer handles it (BitcoinManager→`did:btco:test`, transfer→signet
validation, address validation), but the constructor's validation array
omitted it — so `OriginalsSDK.create({ network: 'testnet' })` threw
`Invalid network`. This bricked the landing demo (and any testnet4 consumer)
whenever a testnet network was configured. The guard now accepts `testnet`.
