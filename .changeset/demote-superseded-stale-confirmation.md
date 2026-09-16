---
"@originals/landing": patch
---

Demote a superseded inscription pair's stale `confirmed` status once fresh evidence shows its own commit no longer confirms (#777).

The `supersededPending` reconciliation pass only handled positive evidence (reclaim once a superseded pair's own commit confirms). A negative read was a no-op, so a record that reached `status: 'confirmed'` and was then superseded by a rival kept reporting `confirmed` / `settled: true` forever, even after its own commit stopped confirming (e.g. the rival that beat it out was itself later invalidated by a deeper reorg). It is now demoted to `reveal_broadcast` via a compare-and-set write, mirroring the existing live-path reorg demotion, while staying `superseded` so the outpoint is never reclaimed on negative evidence.
