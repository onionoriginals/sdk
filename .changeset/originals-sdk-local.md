---
'@originals/sdk': minor
'@originals/vh': minor
---

Add `@originals/sdk/originals`, the Originals Protocol local workflow (plan 011, PR 4). It provides create (or an unsigned draft), edit with an explicit parent, deactivate, commit with identical-retry detection, ZIP evidence packages with load and import, a durable `FileStore` (`@originals/sdk/originals/fs`), the `keySigner` contract, and an `originals` CLI that verifies packages offline. `@originals/vh` gains unsigned `prepare*` builders. `@originals/vh` becomes a public package (owner decision Q11).
