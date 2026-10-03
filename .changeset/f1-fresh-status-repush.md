---
'@originals/landing': patch
---

Fix `POST /api/btc/inscribe/rebroadcast`'s F1 recovery guard (re-push an evicted commit before retrying the reveal) reading a stale status snapshot, so it never fired on its first call for a record that had never previously broadcast (#793).

The guard checked the call's original record snapshot, taken before the same call's own commit-broadcast branch could move that record from `signed` to `commit_broadcast`. When a record started at `signed` and this one call successfully broadcast the commit but the reveal then failed with a missing-inputs error, the guard's `status === 'signed'` snapshot never matched `commit_broadcast`/`reveal_broadcast`, so the commit was never re-pushed and the reveal was left un-retried — even though the on-disk record was, by then, genuinely past `signed`. A second, identical manual retry worked, because by then the freshly-loaded snapshot already reflected the transition.

The guard now reads the already concurrency-checked snapshot taken immediately after the reveal broadcast attempt, so it sees this same call's own status transition instead of the value read before it.
