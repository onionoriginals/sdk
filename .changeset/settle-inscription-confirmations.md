---
"@originals/landing": patch
---

Define an explicit settlement policy for confirmed Bitcoin inscriptions (#567).

Durable inscription state only recorded the broadcast phase — it never persisted inclusion block height or distinguished confirmed-but-unsettled from settled, so a reorg-then-reconfirm that landed in a different block was indistinguishable from uninterrupted confirmation.

- `GET /api/btc/inscribe` and the manual rebroadcast route now report `settled`, `confirmations`, `confirmedBlockHeight`, and `confirmedBlockHash` on confirmed records, instead of a bare `status: 'confirmed'` that could mean either.
- The six-confirmation retention/settlement threshold is now an explicit, configurable policy (`recoveryConfirmations` / `BTC_RECOVERY_CONFIRMATIONS`) that can only be raised, never lowered below six.
- A reconfirmation whose block identity differs from the one last observed — evidence of a reorg, including an ordinary one-block reorg that replaces the block at the SAME height — is recorded even when an earlier poll never saw the intervening unconfirmed state, and logged as a new `inscribe_reorg_reconfirmed` money-log event.
