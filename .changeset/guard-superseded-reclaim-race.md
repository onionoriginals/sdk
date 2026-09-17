---
"@originals/landing": patch
---

Fix a TOCTOU race (#758) where the `supersededPending` reconciliation pass could clobber a concurrent pass's result for the same inscription record.

The pass reads a record, awaits a provider status lookup, reclaims the winning pair's outpoint, then awaits a reveal broadcast before deciding the record's final status — but it wrote that decision with a bare `setStatus` instead of the guarded `trySetStatus` every sibling pass (`liveStuck`, `liveUnconfirmed`) already uses after its own awaits (#677/#709). A concurrent pass (an overlapping poll, or the background sweep) that confirmed or retired the same record while either await was in flight got silently overwritten by this pass's own stale decision.

The record is now re-checked after the status-lookup await before reclaiming, and the terminal write after the reveal-broadcast await goes through `trySetStatus` against the fresh post-reclaim snapshot (`reclaimOutpoint` clears `superseded`, so that snapshot — not the pre-reclaim one — is what a concurrent pass must still match). The reclaim itself (rival retirement, winner reinstated) still always applies; only the terminal status write is now guarded.
