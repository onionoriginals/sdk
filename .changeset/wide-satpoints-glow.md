---
"@originals/cel": patch
"@originals/sdk": patch
---

**Fix: satpoint comparisons now normalize hex casing on both sides, instead of only one.** (#733)

`prepareBitcoinPublication`'s identity-sat alignment check (`packages/sdk/src/v3/bitcoin.ts`) lowercased only the caller-supplied funding UTXO's txid before comparing it against the configured `SatProvider`'s reported `ownership.satpoint`, which carries no casing contract of its own. A provider or caller-supplied `Utxo.txid` that used a different hex letter case than the other side happened to use caused a spurious `ASSET_SAT_ALIGNMENT` failure for a funding input that genuinely was the identity sat's current holder.

`resolveSat`'s independent-ownership cross-check (`packages/cel/src/v3/publications.ts`) had the same one-sided gap: an independent enumeration source's `ownership.satpoint` was compared to the primary snapshot's with strict, case-sensitive equality.

Both now compare through a new shared `normalizeSatpoint` export (`@originals/cel/v3`), which lowercases only the txid component of a well-formed `<64-hex-txid>:<vout>:<offset>` satpoint and leaves any other value unchanged, so a genuinely malformed or differing satpoint still fails comparison.
