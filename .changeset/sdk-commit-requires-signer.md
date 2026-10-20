---
"@originals/sdk": patch
---

`commit` (and so `edit`, `deactivate` and `publish`) called without a usable signer now fails with an `OriginalsError` (`unauthorized-key`, `SIGNER_REQUIRED`) instead of a `TypeError`, and writes nothing. Found by the local release acceptance run (#976): an imported Original edited with no author key.
