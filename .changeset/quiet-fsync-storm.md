---
"@originals/landing": patch
---

Fix a redundant fsync'd write on every reconciliation poll of a confirmed-but-unsettled inscription (#742).

`bitcoin-reconciliation.ts`'s `liveUnconfirmed` write-skip check compared a confirming poll's raw `blockHeight`/`blockHash` against the stored record, instead of the EFFECTIVE block identity a write would actually produce. `QuickNodeProvider.getTransactionStatus` resolves `blockHeight` via a separate best-effort RPC call that can legitimately come back omitted on any given poll even while `blockHash`/`confirmations` are unchanged — that omission read as "changed" and triggered a synchronous `openSync`/`writeSync`/`fsyncSync` write on essentially every 15s poll for the entire recovery window, up to the six-confirmation floor. Stored confirmation evidence itself stayed correct throughout (`applyStatus`'s sticky-field handling already preserves it), so this was a performance defect, not a data-loss one.

The write-skip check now derives the same effective next height/hash `applyStatus` would produce before comparing, so an omitted-but-unchanged field is a no-op again.
