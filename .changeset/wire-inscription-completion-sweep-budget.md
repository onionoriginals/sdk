---
"@originals/landing": patch
---

Fix #812: the unattended inscription-completion sweep's real production path was capped at 10 distinct users per pass, undermining the guarantee its retired dedicated module (`inscription-completion-sweep.ts`, written for #545) was tested against but never wired into `serve.ts`.

Both of `serve.ts`'s actual triggers (per-block and hourly fallback) call `bitcoin-reconciliation.ts`'s `sweepInscriptions`, which already reconciles a confirmed-commit/stuck-reveal record per user (the `liveStuck` category) but hard-capped its per-pass budget at 10 distinct sub-org ids — well under the retired module's 25-candidate design target — so a batch of stranded reveals spanning more than 10 distinct users converged only over additional hourly/per-block cycles instead of in one pass.

- `sweepInscriptions`'s per-pass budget is now a configurable `sweepBudget` (default 25, matching the retired module's intent).
- The shared reconciliation path now logs the unattended reveal push (`inscription_sweep_completed`) and any failed push (`inscription_sweep_push_failed`) to the money log, preserving the "every push, skip and failure is reconstructable from the money log alone" guarantee the retired module documented.
- The now-dead `inscription-completion-sweep.ts` module, its dedicated test, and the `pendingRevealBroadcasts` store method that existed only to serve it are removed.
