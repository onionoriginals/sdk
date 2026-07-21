---
"@originals/sdk": patch
---

QuickNodeProvider: recognize `testnet4` (and `testnet3`) as the `testnet` network in its `getblockchaininfo.chain` guard. Modern bitcoind reports `chain: "testnet4"`, which previously failed the network check with a false "endpoint serves a different chain" error.
