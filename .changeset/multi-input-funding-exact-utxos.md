---
"@originals/sdk": minor
---

Support multi-input funding for inscriptions, and stop the commit builder from silently dropping a caller's UTXO.

`inscribeOnBitcoin` now accepts `fundingUtxos: Utxo[]` (the singular `fundingUtxo` stays as a one-element shorthand). The identity satoshi is pinned to the first funding UTXO and re-asserted against the built and signed transaction, rather than being implied by there being exactly one input.

This closes a latent funds-safety bug: `createCommitTransaction` selects value-descending and stops once the target is covered, so passing a caller-ordered set could drop the identity UTXO entirely and inscribe on the wrong satoshi. The new `exactUtxos` mode spends the caller's exact set in the caller's exact order and fails closed rather than narrowing.

`OrdinalsProvider.submitInscription` gains a `fundingUtxos` array carrying every funding input in order, so an implementation persisting for recovery can claim all of them. The change is additive: the singular `fundingUtxo` stays required and keeps mirroring the identity input, so existing implementations continue to compile.

Also fixes a commit-builder dead end that a fundable set could hit. The final fee was priced against an output count re-derived from the estimated fee rather than the count the funding check was made against; above roughly 17.6 sat/vB (P2WPKH change) a surplus that clears dust flipped the transaction back to two outputs and threw `Outputs exceed inputs`. The builder now reuses the planned output count, absorbing a surplus too small to make a viable change output into the fee.
