---
"@originals/sdk": minor
---

Guard the double-inscription hazard with a single shared keyed lock (#303). A new `OperationLock`, keyed by the canonical DID and shared via SDK config, is claimed at the money-spending inscription path so `LifecycleManager.inscribeOnBitcoin` and `MigrationManager` migrations of the same DID can no longer both broadcast paid commit/reveal pairs — replacing the two uncoordinated per-instance in-memory Sets that didn't see each other.
