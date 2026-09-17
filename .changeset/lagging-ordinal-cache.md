---
'@originals/landing': patch
---

**`cachedOrdinalLookup` no longer permanently memoizes a stale "no inscriptions" verdict (#859).**

The per-outpoint ordinal classification cache treated every answer as permanently valid, on the reasoning that an unspent output's inscription set can't change. That's true of the on-chain fact, but not of the ord indexer's *report* of it: ord is known to lag behind the UTXO indexer that feeds the same deposit/inscribe polling. If the first classification query for an outpoint landed before ord had processed the block containing its inscription reveal, the wrong "clean" answer was cached forever — even after the indexer caught up — leaving a 546-sat inscribed output eligible to be pulled in as a funding top-up and burned as fees.

The cache now treats the two verdicts asymmetrically: a positive (inscribed) result is still cached permanently, since that fact cannot un-happen while the output stays unspent, but an empty/"clean" result is only trusted for a bounded TTL (5 minutes by default) before being re-verified against the index. A lookup failure still isn't cached either way.
