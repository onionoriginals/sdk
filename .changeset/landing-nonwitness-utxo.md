---
"@originals/landing": patch
---

**Fix: attach the previous transaction Turnkey requires to sign the commit.**

The first real mainnet inscription failed at signing:

```
sign_transaction code 3: input 0 is missing non_witness_utxo for
SegWit v0 input; provide both witness_utxo and non_witness_utxo
```

BIP-143 does not need the full previous transaction to compute a SegWit v0
sighash, so the SDK's commit builder attaches only `witnessUtxo`. Turnkey
requires it anyway — the defence against the fee-inflation attack on remote
signers, which otherwise learn the input's true value only from the party
asking for a signature.

The browser now fetches each funding input's previous transaction and attaches
it before signing, and **verifies** rather than trusts it: the bytes must hash
to the txid the PSBT names, and the output being spent must match the
`witnessUtxo` already in the PSBT in both amount and script. A mismatch is
refused, not signed.

The lookup goes through `GET /api/btc/prevtx`, which is scoped to the caller's
own bound deposit address rather than being a general transaction proxy, and
keeps a creator's funding txids away from a public indexer tied to their IP.
