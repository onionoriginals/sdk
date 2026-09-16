---
"@originals/landing": patch
---

Fix #825: `applyStatus()`'s confirmed-evidence bookkeeper could pair a fresh `confirmedBlockHeight` with a stale `confirmedBlockHash` left over from a different, older block, when a "confirmed" evidence write supplied a new height but omitted the hash.

Height and hash describe one block identity and must never drift out of sync with each other. The function already cleared a stale height when a fresh hash proved the identity changed; it now symmetrically clears a stale hash when a fresh height proves the identity changed and this read has no hash opinion. Without this, a later, fully correct read of that same block could be misdetected as a same-height reorg that never happened (a spurious `inscribe_reorg_reconfirmed` money-log event), and the mismatched pair was exposed externally via `GET /api/btc/inscribe`.
