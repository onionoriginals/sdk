---
"@originals/landing": patch
---

Fix a missing negative-evidence demotion (#777) in the `supersededPending` reconciliation pass: a superseded record that reached `status: 'confirmed'` before a rival pair reclaimed its outpoint (`supersede()` sets `superseded` without touching `status`/evidence) kept reporting `confirmed`, with stale confirmation evidence, forever after — even once its own commit stopped confirming in a deeper reorg. The pass's own status lookup for that commit already produces fresh negative evidence in exactly this case; it was simply discarded (`if (!st?.confirmed) continue`).

A real `{ confirmed: false }` read (distinguished from a provider outage, where `readStatus` returns `null` and the last observed state is preserved) now CAS-demotes a still-`confirmed` superseded record back to `reveal_broadcast`, keeping `superseded: true`. The guard's expectation includes the confirmation evidence captured before the status lookup's own await, so a stale negative read cannot clobber fresher confirmation evidence a concurrent pass wrote in the meantime; on a CAS failure the concurrent pass's newer state stands untouched, mirroring the `confirmed` → `reveal_broadcast` demotion guard already used for `liveUnconfirmed`.

Builds on #758/#760, which guards the same loop's positive/reclaim path but left this negative branch unchanged.
