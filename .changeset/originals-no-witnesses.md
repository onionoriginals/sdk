---
'@originals/vh': minor
---

Originals asset logs do not use witnesses (owner decision Q14). An entry that sets the VH witness parameter to anything but `{}` is rejected with `WITNESS_NOT_PERMITTED` (invalid-evidence), replacing the interim `WITNESS_NOT_SUPPORTED_YET`. Unanchored ordering is claimed only; Bitcoin anchoring gives proven ordering.
