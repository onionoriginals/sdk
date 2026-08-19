---
"@originals/sdk": minor
---

Real-BTC hardening for the sat-selected inscribe path.

- **BIP-125 RBF on every built input**: the commit and reveal builders (and
  the landing faucet's funding tx) now set sequence `0xfffffffd` instead of
  @scure/btc-signer's final-sequence default, so a fee spike can never park a
  real-BTC transaction with no bump path. `RBF_SEQUENCE` is exported from the
  commit builder.
- **Atomic `submitInscription` seam on `OrdinalsProvider`** (optional): when a
  provider implements it, `inscribeOnSat` submits the signed commit+reveal
  pair in ONE call instead of two sequential `broadcastTransaction` calls,
  letting the implementation persist both transactions durably BEFORE
  anything is broadcast — the stranded-funds fix: a caller that dies between
  commit and reveal can no longer orphan the committed funds. A failed submit
  throws `INSCRIPTION_SUBMIT_FAILED` carrying full recovery data (both signed
  tx hexes, txids, sat, inscription id). Providers without the seam keep the
  existing two-broadcast behavior and `REVEAL_BROADCAST_FAILED` semantics.
