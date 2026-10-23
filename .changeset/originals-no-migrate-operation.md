---
'@originals/vh': patch
---

There is no `migrate` operation (P9.10; P14.4, PROVISIONAL, section 14): anchoring is an update that adds the sat's did:btco alias, so an entry whose operation is `migrate` (or `publish`) is now `invalid-evidence` `STATE_OPERATION`, not `unsupported-profile` `STATE_OPERATION_UNSUPPORTED`.
