---
"@originals/sdk": patch
---

Add optional `blockHash` to `OrdinalsProvider.getTransactionStatus()`, returned by `QuickNodeProvider` and `RegtestProvider` (already available from verbose `getrawtransaction`, previously discarded after resolving height) and `SignetProvider` (from ord's `/tx/<txid>` response).

Block height alone is not block identity: an ordinary one-block reorg can replace the block at a given height with a different one, which a height-only comparison cannot distinguish from uninterrupted confirmation. Consumers that need to detect a reorg (rather than just read confirmation depth) should compare `blockHash` when available.
