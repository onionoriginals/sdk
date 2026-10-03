---
"@originals/sdk": patch
---

Report `ASSET_SAT_OCCUPIED` when a complete fresh Bitcoin observation shows a different Original already accepted on the proposed boundary sat. Preserve `ASSET_ACCEPTED_HEAD_REQUIRED` for missing or incomplete evidence, and reject the occupied sat before controller or Bitcoin signing.
