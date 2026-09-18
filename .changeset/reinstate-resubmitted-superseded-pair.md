---
"@originals/landing": patch
---

Fix `POST /api/btc/inscribe` broadcasting a resubmitted commit/reveal pair while leaving its funding outpoint with zero live records (#874).

When a rebuilt rival pair superseded an original, never-broadcast pair on the same funding outpoint, and that rival later failed to broadcast and was itself superseded by a resubmission of the original pair's exact bytes, nothing ever cleared the original pair's own stale `superseded: true` flag — `store.create` is a no-op for an already-persisted `commitTxId`. The subsequent guarded status-write CAS then silently failed (its `superseded: false` expectation never matched), so a real, successful commit broadcast was reported back as the stale `'signed'` status, and both the original and the rival ended up `superseded`, leaving the outpoint with no live record and no double-spend/conflict protection until the commit's first confirmation self-healed it via reconciliation.

The `inscribe` handler now reinstates (clears `superseded`) the resubmitted record itself, alongside superseding its rival, mirroring the paired supersede/reinstate pattern `reclaimOutpoint` already uses in `bitcoin-reconciliation.ts`.
