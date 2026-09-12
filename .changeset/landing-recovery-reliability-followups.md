---
'@originals/landing': patch
---

**Recovery reliability: cache fee-estimator outages briefly, and stop the deposit sweep from silently aging out an address it keeps checking (#496).**

`currentFeeRate` now remembers a failed estimate for a short window (10s) instead of clearing its single-flight slot on rejection with no backoff. During a real estimator outage, every one of a creator's polls used to issue a fresh RPC against a dependency that was already down; now a poll inside the window gets the same fail-closed error without re-asking the estimator, and a poll past the window is a genuine retry.

`recordDepositRead` used to skip its write whenever the reported balance was unchanged, with no ceiling on how stale that could get. That froze the persisted `lastRead.at` at the last actual balance *change* rather than the last time anyone checked — and the balance-sweep's 24h drop-out rule reads exactly that timestamp. An idle, zero-balance address that the sweep kept re-reading every hour could still silently age out of the sweep, because each of those unchanged re-reads was a no-op. A write now lands at least once an hour even when nothing changed, so an address still being actively checked never freezes into a false "nobody has looked in 24h" reading.

Three other follow-ups filed alongside these in #496 — durable-store write failures surfacing distinctly from a provider outage, a per-pass reconciliation read floor for later categories, and the automatic list-poll recovering a stranded commit without a manual "Finish inscription" click — are already covered by the current reconciliation implementation; this closes the two that were not.
