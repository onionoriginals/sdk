---
"@originals/cel": patch
---

Report recognized CCG `previousLog` documents as unsupported (`CEL_PREVIOUS_LOG`) before validating their inner Originals entries. Preserve outer document, log-count, JSON-value, and previousLog shape validation; malformed references remain invalid and no additional documents are accepted.
