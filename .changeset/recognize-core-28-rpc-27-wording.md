---
"@originals/landing": patch
"@originals/sdk": patch
---

Fix `isAlreadyKnownTxError` failing to recognize Bitcoin Core >=28.0's rewritten RPC -27 ("already in chain/mempool") rejection message (#889).

`ALREADY_KNOWN_TX_ERRORS` only matched Core's pre-28.0 wording ("transaction already in block chain"). Core 28.0 rewrote that message to "Transaction outputs already in utxo set" (bitcoin/bitcoin#30212), which is what this repo's own regtest evidence (Core 31.1) and QuickNode actually emit — so a rebroadcast of an already-mined transaction was misread as a real failure, permanently sticking a record at `commit_broadcast` and 502ing the manual Finish-button recovery meant to rescue exactly that case. `isAlreadyKnownTxError` now checks the RPC -27 error code first (stable across Core versions) before falling back to prose matching, and adds the new wording as a fallback for providers that only expose a message. Fixed in both `apps/landing/server/bitcoin.ts` and the mirrored `packages/sdk/src/bitcoin/inscription-recovery.ts`.
