---
"@originals/auth": patch
---

**`turnkeySignBytes` now validates the r/s component boundary, not just the aggregate signature length** (#688).

`turnkeySignBytes` stripped `0x` from Turnkey's returned `r` and `s` hex strings separately, then concatenated them and checked only `signature.length !== 64`. A short `r` paired with a correspondingly long `s` (or vice versa) still totals 64 bytes, so the boundary itself was never verified — the mis-split bytes were silently accepted as an apparently-valid 64-byte Ed25519 signature. `cleanR` and `cleanS` are now each individually required to be exactly 32 bytes (64 hex chars) before concatenation.
