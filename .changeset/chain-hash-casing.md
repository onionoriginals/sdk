---
"@originals/sdk": patch
---

**Fix: independent Bitcoin chain-tip and block-hash comparisons now normalize hex casing.** (#844)

`createBitcoinCoreChainValidator`'s `checkTip`/`validate` (`packages/sdk/src/v3/chain-validation.ts`) compared a configured `SatProvider`'s reported tip/block hashes and block txids against Bitcoin Core's RPC-returned values with plain `!==`. `resolution.ts`'s `validChainTip`/`sameChainTip` (used by `usableIndependentSnapshot` and the ownership cross-check) likewise required lowercase-only hex and compared hashes case-sensitively. Neither hex hash carries a casing contract of its own, so a provider or independently configured index reporting the identical chain fact in a different, individually valid hex case was treated as a disagreement (`SAT_SNAPSHOT_CHAIN_DISAGREEMENT`) or an unusable observation (`status: "incomplete"`) instead of being accepted, contradicting CLAUDE.md's "Provider snapshots must establish ... active-chain ordering" contract.

Both now normalize through the existing shared `normalizeTxid` export (`@originals/cel/v3`, already used for reveal-txid comparisons), so two sources reporting the same chain fact in different hex letter case agree, while a genuinely different hash still fails comparison.
