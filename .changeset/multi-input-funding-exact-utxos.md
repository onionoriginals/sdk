---
"@originals/sdk": minor
---

Support multi-input funding for inscriptions, and stop the commit builder from silently dropping a caller's UTXO.

`inscribeOnBitcoin` now accepts `fundingUtxos: Utxo[]` (the singular `fundingUtxo` stays as a one-element shorthand). The identity satoshi is pinned to the first funding UTXO and re-asserted against the built and signed transaction, rather than being implied by there being exactly one input.

This closes a latent funds-safety bug: `createCommitTransaction` selects value-descending and stops once the target is covered, so passing a caller-ordered set could drop the identity UTXO entirely and inscribe on the wrong satoshi. The new `exactUtxos` mode spends the caller's exact set in the caller's exact order and fails closed rather than narrowing.
