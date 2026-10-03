---
"@originals/sdk": patch
---

**`submitPreparedInscriptionOnSat`/`resumeInscriptionOnSat` no longer downgrade a healthy `reveal_broadcast` status or misreport an ordinary duplicate-broadcast rejection as an error (#816).**

Retrying a prepared pair whose reveal was already recorded as `reveal_broadcast` but isn't yet independently confirmed — the normal window before the first confirmation — could downgrade the persisted status before even attempting resubmission, and had no way to distinguish a provider's "already on the network" rejection of the identical bytes (a positive signal) from a genuine lost/failed broadcast. Both a prior definite `reveal_broadcast` record and a closed-set `isAlreadyKnownTxError` classification (mirroring `apps/landing/server/bitcoin.ts`'s existing pattern) now resolve an ambiguous resubmission rejection as continued success instead of a fresh error, per `packages/sdk/V3.md`'s "retry the same prepared wrapper; never rebuild merely because an acknowledgement was lost" contract. Genuine eviction/reorg recovery is unaffected.
