---
"@originals/sdk": minor
"@originals/landing": patch
---

A guided path through Create → Add a version → Export → Verify, imported from `@originals/sdk` alone. `OriginalsStudio.start()` makes a local author and a store. `create`, `addVersion({ bytes, label, note })`, `export()` and `studio.verify(zip)` each wrap the full workflow. Also new: `createLocalAuthor`/`restoreLocalAuthor`, `isVerified` (the `originals verify` verdict), and re-exports of `OriginalsError` and the report types, so callers need nothing from `@originals/vh`. The landing app now uses the SDK's `createLocalAuthor`.
