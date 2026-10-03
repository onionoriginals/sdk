---
"@originals/cel": patch
---

**Fix: the JSON reader accepts the large integers its own JCS writer emits.** The exact-binary64 integer-literal rule rejected RFC 8785 output for integral values in [2^53, 1e21): JCS writes `2**61` as `2305843009213694000` (shortest round-trip digits), not its exact decimal, so a document carrying such a value encoded to JSON but could not be read back, while the same value round-tripped through CBOR. A plain integer literal is now accepted when it names its binary64 exactly or is that binary64's JCS spelling; any other literal (e.g. `9007199254740993`) is still rejected with `CEL_NUMBER`. The profile spec and both independent reference checkers state the same rule.
