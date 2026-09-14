---
'@originals/landing': patch
---

**Manual inscription recovery now survives a provider outage and a concurrent retirement without corrupting state (#705).**

`POST /api/btc/inscribe/rebroadcast` used to fold a transient `getTransactionStatus` failure into the same path as an explicit reorg, so a provider hiccup could demote an already-`confirmed` inscription and trigger a redundant re-broadcast. The automatic reconciliation poll already preserved the last observed state on an outage; the manual endpoint had no equivalent guard.

The endpoint also acted on a single snapshot of the record read before the status lookup, unchanged across every subsequent broadcast. A concurrent reconciliation/sweep pass that retired the same record mid-flight (its funding outpoint's rival just won and confirmed) could be overwritten by a stale decision, leaving a retired, hex-less row stamped with a live, non-terminal status that later reconciliation permanently ignores.

The status read is now three explicit outcomes (confirmed / explicitly unconfirmed / unavailable), only explicit evidence can demote a confirmed record, and the record is re-read after the lookup so every mutating decision acts on current store state.
