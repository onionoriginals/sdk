---
"@originals/sdk": patch
---

Bump `uuid` from 13.0.2 to 14.0.1. Only the `v4` export is used by the SDK (`ResourceManager`, `StateTracker`, `CheckpointManager`), whose API is unchanged in this release, so this is a routine dependency update with no consumer-facing behavior change.
