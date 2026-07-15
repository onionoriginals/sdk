---
"@originals/sdk": minor
---

`inscribeOnBitcoin` can now inscribe the genesis did:btco onto a caller-chosen
funding UTXO whose first sat becomes the DID: the sat is derived from the
provider's sat index (`getFirstSatOfOutput`), the commit is signed by a caller
`BitcoinSigner`, and the result is verified fail-closed against the intended sat
(`SAT_MISMATCH` rolls back and commits nothing). Callers now control the
permanent `did:btco:<sat>` identity instead of accepting an arbitrary
provider-selected sat. The legacy `inscribeOnBitcoin(asset)` /
`(asset, feeRate)` path is unchanged. (#369)
