---
"@originals/sdk": minor
---

**Two signer-facing improvements, both from the first real mainnet inscription.**

**`Utxo.prevTxHex` (optional).** BIP-143 computes a SegWit v0 sighash from
`witnessUtxo` alone, so the commit builder never attached the previous
transaction. Some signers require it regardless — Turnkey answers
`code 3: input N is missing non_witness_utxo for SegWit v0 input`, and hardware
wallets have long demanded it as their only defence against being lied to about
an input's value. Supply `prevTxHex` on a funding UTXO and the commit builder
attaches `nonWitnessUtxo`; omit it and nothing changes.

It is verified, not trusted: the bytes must hash to the UTXO's `txid`, and the
output at `vout` must match its value and `scriptPubKey`. An unchecked
`nonWitnessUtxo` is exactly what the fee-inflation attack substitutes, so a
mismatch throws rather than being signed.

**`InscribeOnSatResult.broadcast`.** `submitInscription` already returned
`'commit_broadcast' | 'reveal_broadcast'`, and `inscribeOnSat` discarded it —
so callers could not tell a completed pair from a commit-only broadcast where
the reveal is persisted for rebroadcast. Both are successes, but only one means
the inscription exists; a UI built on the missing distinction announced an
inscription and linked to a reveal txid that returned 404.

A provider that reports no status is treated as complete, which is what it has
always meant, so existing implementations are unaffected.
