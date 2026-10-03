---
"@originals/sdk": patch
---

Allow CLI offline verification of complete signed envelopes at every layer, reporting local history and byte completeness separately from unverified hosted or Bitcoin publication evidence. Preserve strict rejection of missing historical bytes, unsigned drafts, invalid proofs, and corrupted attachments. Add top-level authenticated state to `inspect --log` for JSON and CBOR while preserving `verify --log` output.
