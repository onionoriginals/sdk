---
"@originals/cel": minor
---

`verifyEventLog`'s result now includes `headFreshnessChecked: boolean`, true only when `options.checkHeadFreshness` was requested, the default (non-custom-verifier) path was used, and the log's authority walk actually established an on-chain anchor — i.e. exactly when `verifyHeadFreshness` genuinely ran.

Previously a caller had no reliable way to tell "head-freshness was checked and passed" apart from "the flag was a no-op because the log was never anchored" other than re-deriving anchoring from raw proof shape, which a crafted log could spoof (a `bitcoin-ordinals-2024`-shaped proof entry can appear on a log whose authority walk never actually completed).
