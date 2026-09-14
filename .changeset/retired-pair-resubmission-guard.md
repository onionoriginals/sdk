---
"@originals/landing": patch
---

Fix `POST /api/btc/inscribe` accepting a resubmission of an already-`retired` signed commit+reveal pair (#693).

Previously, resubmitting the exact same signed bytes for a commit that had already settled — a plausible ambiguous-acknowledgement retry, where the client never saw the original response — was silently reprocessed: the mismatch check treated the retired record's cleared `signedCommitHex`/`revealTxHex` as "no mismatch", so the request fell through into a full re-broadcast that regressed the record's status from `confirmed` back to `reveal_broadcast` while leaving `retired: true` set. That internally-inconsistent combination permanently excluded the record from reconciliation, and the manual `/rebroadcast` endpoint then falsely reported the (in fact fully confirmed) inscription as terminal/`not_recoverable`.

- A resubmission whose `commitTxId` matches an already-`retired`, settled (`status: 'confirmed'`) record now returns the recorded settlement result idempotently, with no re-verification, broadcast, or state write.
- A resubmission matching a `retired` record that never settled here (a terminally-dead superseded loser whose funding outpoint a different, confirmed pair already won) is refused outright (`commit_retired`, 409) instead of being reprocessed.
- The same retirement check is re-applied inside the per-user submission lock, covering the case where reconciliation retires the record concurrently while the request's economics/ordinal checks are in flight.
