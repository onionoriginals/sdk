---
"@originals/sdk": patch
---

Migration/lifecycle hardening: fix per-item options merge in `MigrationManager.migrateBatch` (per-item `sourceDid`/`targetLayer` no longer clobbered); persist checkpoints and the signed audit trail through shipped storage adapters via a canonical `putObject/getObject` shape (with legacy `put/get` and tombstone/index fallbacks); add a concurrency guard to `transferOwnership` and duplicate-asset detection to `validateBatchTransfer`; make fail-fast batch modes actually stop and return a stable `BatchError` snapshot; implement `atomicRollback` for the publish path; reclaim `FAILED`/`QUARANTINED` states in `StateTracker.cleanupOldStates`; and validate partial-mode storage capability in `StorageValidator`.
