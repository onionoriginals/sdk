---
"@originals/landing": patch
---

Define an explicit settlement policy for confirmed Bitcoin inscriptions (#567).

Durable inscription state only recorded the broadcast phase — it never persisted inclusion block height or distinguished confirmed-but-unsettled from settled, so a reorg-then-reconfirm that landed in a different block was indistinguishable from uninterrupted confirmation.

- `GET /api/btc/inscribe` now reports `settled`, `confirmations`, and `confirmedBlockHeight` on confirmed records, instead of a bare `status: 'confirmed'` that could mean either.
- The six-confirmation retention/settlement threshold is now an explicit, configurable policy (`recoveryConfirmations` / `BTC_RECOVERY_CONFIRMATIONS`), still defaulting to six.
- A reconfirmation at a different block height than last observed — evidence of a reorg — is recorded even when an earlier poll never saw the intervening unconfirmed state, and logged as a new `inscribe_reorg_reconfirmed` money-log event.
