---
"@originals/sdk": minor
---

`inscribeOnBitcoin` can now inscribe the genesis did:btco onto a caller-chosen
funding UTXO whose first sat becomes the DID: the sat is derived from the
provider's sat index (`getFirstSatOfOutput`) and the inscription is
deterministically constructed to land on it, with the commit txid computed
locally from the caller `BitcoinSigner`'s broadcast-ready tx. Correctness is
established at derive time (fire-and-forget) — there is no post-broadcast
re-check; the caller owns confirmation monitoring, and a post-commit reveal
failure throws with recovery data (`revealTxHex`) so committed funds are never
stranded. Callers now control the permanent `did:btco:<sat>` identity instead of
accepting an arbitrary provider-selected sat. The legacy `inscribeOnBitcoin(asset)` /
`(asset, feeRate)` path is unchanged. (#369)
