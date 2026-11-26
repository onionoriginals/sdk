---
"@originals/sdk": minor
"@originals/landing": patch
---

A first Original now needs nothing from `@originals/vh`: `createLocalAuthor` and `restoreLocalAuthor` make and restore an author DID on this device, `isVerified` gives the `originals verify` verdict, and `OriginalsError` and the report and author types are exported from `@originals/sdk`. The README has a tested quick start (create, edit, export, verify) and ORIGINALS.md has diagrams of the whole workflow. The landing app now uses the SDK's `createLocalAuthor`.
