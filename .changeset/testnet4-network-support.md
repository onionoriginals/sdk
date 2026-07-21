---
"@originals/sdk": minor
---

Add first-class `network: 'testnet'` (testnet4) support. A testnet-configured SDK mints `did:btco:test:<sat>` identifiers and validates `tb1` testnet addresses; the config/DID-identity network unions and prefix maps accept `'testnet'` across `types`, `btcoDid`, `createBtcoDidDocument`, `DIDManager`, `LifecycleManager`, `BitcoinManager`, `BtcoCelManager`, and `bitcoin-address`. The Bitcoin transaction layer already mapped `testnet` → `TEST_NETWORK`. `QuickNodeProvider` accepts `expectedNetwork: 'testnet'` for testnet4 reads/broadcast.
